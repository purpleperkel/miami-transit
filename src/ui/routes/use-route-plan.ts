import { useEffect, useMemo, useRef, useState } from 'react';

import type { StationListing } from '@/data/schedule-queries';
import type { ScheduleRepo } from '@/data/schedule-repo';
import { instantWindow } from '@/domain/gtfs/service-day';
import { overlayLive } from '@/domain/routes/overlay';
import type { PlanOutcome, PolitePlanClient } from '@/domain/routes/polite-client';
import type { Itinerary, PlanQuery } from '@/domain/routes/transitous';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, type Result } from '@/lib/result';
import { useLive } from '@/live/live-context';
import type { LiveRuntime } from '@/live/runtime';

import { wallClockNowS } from '../clock';
import { copy } from '../copy';
import { askForLocation, currentPosition, useUserPosition } from '../map/use-user-location';
import { watchStation } from '../stations/use-station-predictions';
import type { RecentPlace } from './recent-places';
import { boardingStations, type OptionContext, optionLeavesS, predictionsAt, type RouteNetwork, type RouteOption, routeOptions } from './route-options';

/**
 * Plan M10b.1 (and mfix5), the route options sheet's live half — the hooks the sheet (PlanScreen) composes:
 *
 *   usePlanOrigin    where the plan starts: the rider's location (ONE fix when the sheet opens, through the
 *                    app's location module — a moving start would re-plan, and Transitous asked for few
 *                    requests), or the station whose sheet said "Route from here"
 *   usePlanRequest   Transitous's itineraries for (start, destination) through the app's polite client;
 *                    'superseded' (a newer call replaced this one) is ignored, never shown as an error
 *   useReplanOnceLeft  asks again ONCE per answer, once its first option has left (mfix5)
 *   useChipPosition  where the hurry chips walk from: for "Route from here", the rider when located (mfix5)
 *   useLiveOptions   the itineraries corrected by m4b's live predictions (m10a's overlay) for their
 *                    boarding stations — watched only while the sheet is open, at most MAX_WATCHED_STATIONS
 *                    (REALTIME COST RULE) — as rows sorted by arrival, each with its hurry chip
 */

export type PlanOrigin = { readonly name: string; readonly coordinate: LatLon };
export type OriginState = { readonly kind: 'locating' } | { readonly kind: 'ready'; readonly origin: PlanOrigin } | { readonly kind: 'failed'; readonly message: string };

export type PlanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly itineraries: readonly Itinerary[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

const LOCATING: OriginState = Object.freeze({ kind: 'locating' });
const IDLE: PlanState = Object.freeze({ kind: 'idle' });
const LOADING: PlanState = Object.freeze({ kind: 'loading' });

/** Where the plan starts: `fromStation` once the schedule lists it, else the rider's location. */
export function usePlanOrigin(fromStation: string | null, stations: readonly StationListing[] | null): OriginState {
  const [here, setHere] = useState<OriginState>(LOCATING);
  useEffect(() => (fromStation === null ? locateOnce(setHere) : undefined), [fromStation]);
  const station = useMemo(() => (fromStation === null ? null : stationOrigin(fromStation, stations)), [fromStation, stations]);
  const state = station ?? here;
  invariant(fromStation === null || state.kind !== 'ready' || state.origin.name !== copy.yourLocation, 'a station start is named by its station');
  invariant(state.kind !== 'ready' || isLatLon(state.origin.coordinate), 'a start is a real coordinate');
  return state;
}

function stationOrigin(stationKey: string, stations: readonly StationListing[] | null): OriginState {
  invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  const station = stations?.find((candidate) => candidate.stationKey === stationKey);
  if (stations === null || station === undefined) {
    return stations === null ? LOCATING : { kind: 'failed', message: copy.unknownStation };
  }
  invariant(station.stationKey === stationKey, 'the start is the station asked for');
  return { kind: 'ready', origin: { name: station.name, coordinate: station.coordinate } };
}

/** Asks for location and reads one fix, reporting the start (or why there is none) unless the sheet closed first. */
function locateOnce(report: (state: OriginState) => void): () => void {
  invariant(typeof report === 'function', 'the start is reported to the sheet');
  const life = { open: true };
  const located: Promise<Result<LatLon, string>> = askForLocation().then((grant) => (grant.ok ? currentPosition() : err(grant.error.kind === 'failed' ? grant.error.message : copy.routeNoLocation)));
  located.then(
    (position) => (life.open ? report(position.ok ? { kind: 'ready', origin: { name: copy.yourLocation, coordinate: position.value } } : { kind: 'failed', message: position.error }) : undefined),
    (error: unknown) => (life.open ? report({ kind: 'failed', message: String(error) }) : undefined),
  );
  invariant(life.open, 'the ask starts while the sheet is open');
  return () => {
    life.open = false;
  };
}

/** The tagged answer: which (start, destination) it answers, so a new destination never shows the last one's options. */
type Answer = { readonly key: string; readonly state: PlanState };

/**
 * Transitous's itineraries from `from` to `to`, asked through `client` once per (start, destination) — and
 * again each time `round` moves (a re-plan: leaving now, a new minute, so a new cache key). The answer on
 * screen stays until the new one replaces it.
 */
export function usePlanRequest(client: PolitePlanClient, from: LatLon | null, to: RecentPlace | null, clockMs: () => number, round: number = 0): PlanState {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const key = from === null || to === null ? null : tripKey(from, { latitude: to.lat, longitude: to.lon });
  invariant(Number.isSafeInteger(round) && round >= 0, `a re-plan round is a count, got ${round}`);
  useEffect(() => (from === null || to === null ? undefined : requestPlan(client, planQuery(from, to, clockMs), setAnswer)), [client, from, to, clockMs, round]);
  const state = key === null ? IDLE : answer !== null && answer.key === key ? answer.state : LOADING;
  invariant(key !== null || state.kind === 'idle', 'without a start and a destination there is nothing to plan');
  invariant(state.kind !== 'ok' || answer?.key === key, 'options shown answer the trip asked');
  return state;
}

/** The query for a trip leaving now (the polite client caches it per minute). */
function planQuery(from: LatLon, to: RecentPlace, clockMs: () => number): PlanQuery {
  const query: PlanQuery = { from, to: { latitude: to.lat, longitude: to.lon }, timeEpoch: Math.floor(clockMs() / 1000), arriveBy: false };
  invariant(isLatLon(query.from) && isLatLon(query.to), 'a trip runs between two real coordinates');
  invariant(Number.isSafeInteger(query.timeEpoch), 'a trip leaves at a whole second');
  return query;
}

/** One plan call; its answer is reported unless the sheet moved on first. 'superseded' is not an answer. */
function requestPlan(client: PolitePlanClient, query: PlanQuery, report: (answer: Answer) => void): () => void {
  const key = tripKey(query.from, query.to);
  invariant(typeof report === 'function', 'an answer is reported to the sheet');
  const life = { current: true };
  client.plan(query).then(
    (outcome) => (life.current && outcome.kind !== 'superseded' ? report({ key, state: stateOf(outcome) }) : undefined),
    (error: unknown) => (life.current ? report({ key, state: { kind: 'unavailable', reason: String(error) } }) : undefined),
  );
  invariant(life.current, 'the call starts for the current trip');
  return () => {
    life.current = false;
  };
}

/** Which trip an answer is for: its start and its destination. */
function tripKey(from: LatLon, to: LatLon): string {
  invariant(isLatLon(from) && isLatLon(to), 'a trip runs between two real coordinates');
  const key = `${from.latitude},${from.longitude}|${to.latitude},${to.longitude}`;
  invariant(key.split('|').length === 2, 'a trip key has a start and a destination');
  return key;
}

function stateOf(outcome: Exclude<PlanOutcome, { readonly kind: 'superseded' }>): PlanState {
  invariant(outcome.kind === 'ok' || outcome.reason.length > 0, 'an unavailable answer says why');
  const state: PlanState = outcome.kind === 'ok' ? { kind: 'ok', itineraries: outcome.itineraries } : { kind: 'unavailable', reason: outcome.reason };
  invariant(state.kind === outcome.kind, 'the state is the answer');
  return state;
}

/** The answer the re-plan watches: which one, when it reached the sheet (epoch s), and whether it has asked again. */
type Watched = { readonly itineraries: readonly Itinerary[]; readonly arrivedS: number; readonly asked: boolean };

/**
 * mfix5: asks again (`replan`) ONCE per answer, once its first option has left — so the rows and hurry
 * chips never sit on a train that is gone. An answer whose first option had already left when it arrived
 * never asks (the re-plan's own answer, say, when nothing leaves later): no storm. `replan` null holds
 * the ask (an itinerary's legs are open); it fires when the list is back, if the option has left by then.
 */
export function useReplanOnceLeft(plan: PlanState, options: readonly RouteOption[], nowS: number, replan: (() => void) | null): void {
  const itineraries = plan.kind === 'ok' ? plan.itineraries : null;
  const first = options[0];
  const leavesS = first === undefined ? null : optionLeavesS(first);
  const watched = useRef<Watched | null>(null);
  invariant(Number.isFinite(nowS), 'the re-plan is judged at an instant');
  invariant(itineraries !== null || options.length === 0, 'options come from an answer');
  useEffect(() => replanIfLeft(watched, itineraries, leavesS, nowS, replan), [itineraries, leavesS, nowS, replan]);
}

/** One look at the answer on screen: notes when it arrived, and re-plans the first time its first option has left. */
function replanIfLeft(watched: { current: Watched | null }, itineraries: readonly Itinerary[] | null, leavesS: number | null, nowS: number, replan: (() => void) | null): void {
  invariant(Number.isFinite(nowS), 'the answer is looked at at an instant');
  invariant(leavesS === null || itineraries !== null, 'an option that leaves belongs to an answer');
  if (itineraries === null || leavesS === null) {
    return;
  }
  const seen = watched.current !== null && watched.current.itineraries === itineraries ? watched.current : { itineraries, arrivedS: wallClockNowS(), asked: false };
  const due = !seen.asked && replan !== null && leavesS > seen.arrivedS && nowS > leavesS;
  watched.current = due ? { ...seen, asked: true } : seen;
  if (due) {
    replan();
  }
}

/**
 * Where the hurry chips measure the walk from: for "Route from here" (the plan starts at the station),
 * the rider — followed by the app's ONE location module while the sheet is open — once located; the
 * plan's start otherwise (and always for a plan from the rider's own location, which IS that start).
 */
export function useChipPosition(fromStation: string | null, start: LatLon | null): LatLon | null {
  const rider = useUserPosition(fromStation !== null);
  const position = fromStation !== null && rider.coordinate !== null ? rider.coordinate : start;
  invariant(fromStation !== null || rider.coordinate === null, 'the rider is only followed for a plan from a station');
  invariant(position === null || isLatLon(position), 'the chip walks from a real coordinate');
  return position;
}

/** The rows: `itineraries` with their boarding departures corrected by live predictions, sorted by arrival. */
export function useLiveOptions(itineraries: readonly Itinerary[], network: RouteNetwork, context: OptionContext): RouteOption[] {
  const { state, runtime } = useLive();
  const stations = useMemo(() => boardingStations(itineraries, network), [itineraries, network]);
  const watched = stations.join(' ');
  useEffect(() => (runtime === null || watched === '' ? undefined : watchAll(runtime, watched.split(' '))), [runtime, watched]);
  const predictions = useMemo(() => predictionsAt(state?.predictions ?? null, stations), [state, stations]);
  const overlaid = useMemo(() => overlayLive(itineraries, predictions), [itineraries, predictions]);
  const options = useMemo(() => routeOptions(overlaid, network, context), [overlaid, network, context]);
  invariant(options.length === itineraries.length, 'every itinerary is a row');
  invariant(options.every((option) => option.itinerary === overlaid[option.id]), 'each row is its overlaid itinerary');
  return options;
}

/** Watches every station (counted per station, so the station sheet's own watch is never cancelled); returns the release. */
function watchAll(runtime: LiveRuntime, stationKeys: readonly string[]): () => void {
  invariant(stationKeys.length > 0 && stationKeys.every((key) => key.includes(':')), 'stations are keyed mode:name');
  const releases = stationKeys.map((key) => watchStation(runtime, key));
  invariant(releases.length === stationKeys.length, 'each station has its release');
  return () => releases.forEach((release) => release());
}

/** The schedule's running service days' bases at `nowS` (what clock times count from), or null without any. */
export function useServiceBases(repo: ScheduleRepo | null, nowS: number): readonly number[] | null {
  const minuteS = nowS - (nowS % 60);
  const bases = useMemo(() => (repo === null ? null : basesAt(repo, minuteS)), [repo, minuteS]);
  invariant(Number.isSafeInteger(minuteS), 'the bases are read on the minute');
  invariant(bases === null || bases.length > 0, 'a running schedule has a base');
  return bases;
}

function basesAt(repo: ScheduleRepo, epoch: number): readonly number[] | null {
  invariant(Number.isSafeInteger(epoch), 'the service days are read at a whole second');
  const days = repo.serviceDays(instantWindow(epoch));
  const bases = days.kind === 'active' ? days.days.map((day) => day.baseEpoch) : null;
  invariant(bases === null || bases.length > 0, 'running days have bases');
  return bases;
}
