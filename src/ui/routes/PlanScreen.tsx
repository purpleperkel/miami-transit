import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import type { StationListing } from '@/data/schedule-queries';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { Itinerary } from '@/domain/routes/transitous';
import type { WalkStop } from '@/domain/walk/walk-cache';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { useNowS } from '../clock';
import { copy } from '../copy';
import { useUserPosition } from '../map/use-user-location';
import { TText } from '../primitives/TText';
import { readWalkingPace } from '../settings/walking-pace';
import { SPACING } from '../tokens';
import { useWalkTo } from '../walk/RoutedWalkProvider';
import { ItineraryDetail } from './ItineraryDetail';
import { PlanDestination } from './PlanDestination';
import { PlanUnavailable } from './PlanUnavailable';
import { appPlanClient } from './plan-client';
import { readRecentPlaces, type RecentPlace, recordRecentPlace } from './recent-places';
import { firstRideStops, NO_ROUTE_NETWORK, type OptionContext, type PlaceNames, routeClock, type RouteNetwork, type RouteOption } from './route-options';
import { RouteOptionsList, RoutesAttribution } from './RouteOptionsList';
import { type OriginState, type PlanState, useChipPosition, useLiveOptions, usePlanOrigin, usePlanRequest, useReplanOnceLeft, useServiceBases } from './use-route-plan';

/**
 * Plan M10b.1–M10b.2: the route options sheet (src/app/plan.tsx, titled "Route options"). From the
 * rider's location — or the station whose sheet said "Route from here" — to a place, an address or a
 * station: Transitous's options, corrected by live predictions, earliest arrival first, each with its
 * hurry chip; a tapped option opens its legs here in the sheet, with walking directions one tap away.
 * When Transitous cannot answer, Apple Maps can ("Open in Apple Maps"). The credits sit at the bottom.
 * mfix5: once the first option has left, the open sheet asks again — once per answer, and not while an
 * option's legs are open (the rider may be on that train) — and the hurry chips walk from the rider's freshest
 * fix. For "Route from here", whose plan starts at the station, that is the location module's whenever it has
 * one; for a plan from the rider's own location (mfix8), whose start is the one fix taken when the sheet opened,
 * it is the location module's once that is newer than the sheet's own. mfix9: off the itinerary's start, a chip
 * walking from the rider's fix walks the street-routed walk to its first ride's boarding stop (useChipWalk).
 *
 *   PlanScreen (schedule DB, location, Transitous, live runtime, clock) → PlanBody (props only)
 */

/** The hurry chips count down with this tick. */
export const PLAN_TICK_MS = 15_000;

const NO_ITINERARIES: readonly Itinerary[] = Object.freeze([]);
const NO_STATIONS: readonly StationListing[] = Object.freeze([]);
const NO_STOPS: readonly WalkStop[] = Object.freeze([]);

export type PlanScreenProps = {
  /** The station a plan starts at ("Route from here"), or null for the rider's location. */
  readonly fromStation: string | null;
};

export function PlanScreen({ fromStation }: PlanScreenProps) {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const stations = useMemo(() => (repo === null ? null : repo.stations()), [repo]);
  const network = useMemo<RouteNetwork>(() => (repo === null ? NO_ROUTE_NETWORK : repo.liveNetwork()), [repo]);
  const origin = usePlanOrigin(fromStation, stations);
  const start = origin.kind === 'ready' ? origin.origin : null;
  const from = start === null ? null : start.coordinate;
  const [destination, setDestination] = useState<RecentPlace | null>(null);
  const [recents, setRecents] = useState<readonly RecentPlace[]>(() => readRecentPlaces());
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [reading, setReading] = useState(false);
  const replan = useCallback(() => setRound((previous) => previous + 1), []);
  const plan = usePlanRequest(appPlanClient(), from, destination, wallClockMs, round);
  const nowS = useNowS(PLAN_TICK_MS);
  const { walkMps, jogMps } = readWalkingPace();
  const chipFrom = useChipPosition(start);
  const itineraries = plan.kind === 'ok' ? plan.itineraries : NO_ITINERARIES;
  const walk = useChipWalk(itineraries, chipFrom);
  const context = useMemo<OptionContext>(() => ({ position: chipFrom, nowS, pace: { walkMps, jogMps }, ...(walk === null ? {} : { walk }) }), [chipFrom, nowS, walkMps, jogMps, walk]);
  const options = useLiveOptions(itineraries, network, context);
  useReplanOnceLeft(plan, options, nowS, reading ? null : replan);
  const bases = useServiceBases(repo, nowS);
  const choose = useCallback((place: RecentPlace) => choosePlace(place, setDestination, setRecents, setNotice), []);
  const clear = useCallback(() => setDestination(null), []);
  const names = useMemo(() => placeNames(origin, destination, stations ?? NO_STATIONS), [origin, destination, stations]);
  invariant(fromStation === null || fromStation.includes(':'), `a plan starts at a station keyed mode:name, got "${fromStation}"`);
  invariant(plan.kind === 'idle' || destination !== null, 'a plan is asked only for a destination');
  return (
    <ScrollView testID="plan-sheet" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.sheet} contentContainerStyle={styles.content}>
      <View style={styles.from}>
        <TText variant="footnote" tone="secondary">
          {copy.routeFrom}
        </TText>
        <TText testID="plan-from" variant="headline">
          {originText(origin)}
        </TText>
      </View>
      <PlanDestination destination={destination} recents={recents} stations={stations ?? NO_STATIONS} onChoose={choose} onClear={clear} />
      {notice === null ? null : (
        <TText testID="plan-notice" variant="footnote" tone="secondary">
          {notice}
        </TText>
      )}
      <PlanBody origin={origin} destination={destination} plan={plan} options={options} network={network} names={names} clock={routeClock(bases, nowS)} nowS={nowS} onDetail={setReading} />
      <RoutesAttribution />
    </ScrollView>
  );
}

/**
 * mfix9: the walk the chips take OFF the itinerary's start (route-options.ts OptionContext.walk). The first rides'
 * boarding stops are registered with the app's RoutedWalkProvider (useWalkTo) for EVERY plan while the rider has a
 * fix — "Route from here" and a plan from the rider's own location alike (mfix8 F2) — and never without one. Those
 * walks are measured from the rider's fix, so a chip takes them only while it walks from that very fix
 * (useChipPosition); one walking from the plan's start (no watch fix newer than the sheet's own) keeps the straight line.
 */
function useChipWalk(itineraries: readonly Itinerary[], chipFrom: LatLon | null): OptionContext['walk'] | null {
  const rider = useUserPosition().coordinate;
  const located = rider !== null;
  const stops = useMemo(() => (located ? firstRideStops(itineraries) : NO_STOPS), [located, itineraries]);
  const walk = useWalkTo(stops);
  const fromRider = rider !== null && chipFrom !== null && rider.latitude === chipFrom.latitude && rider.longitude === chipFrom.longitude;
  invariant(located || stops.length === 0, 'without a fix no boarding stop is asked for');
  invariant(!located || chipFrom !== null, 'a located rider always has somewhere the chips walk from');
  return fromRider ? walk : null;
}

function wallClockMs(): number {
  const nowMs = Date.now();
  invariant(Number.isFinite(nowMs), 'the wall clock reads an instant');
  invariant(nowMs > 0, 'the wall clock is past the epoch');
  return nowMs;
}

/** A chosen destination: plan it, and put it first in the recent places (saying so if it could not be saved). */
function choosePlace(
  place: RecentPlace,
  setDestination: (place: RecentPlace) => void,
  setRecents: (places: readonly RecentPlace[]) => void,
  setNotice: (notice: string | null) => void,
): void {
  invariant(place.name.length > 0, 'a destination is named');
  invariant(typeof setDestination === 'function', 'the choice reaches the sheet');
  setDestination(place);
  const saved = recordRecentPlace(place);
  setNotice(saved.ok ? null : `${copy.recentNotSaved}: ${saved.error.message}`);
  if (saved.ok) {
    setRecents(saved.value);
  }
}

/** The From line: the start's name, or what is happening instead. */
function originText(origin: OriginState): string {
  invariant(origin.kind !== 'failed' || origin.message.length > 0, 'a failed start says why');
  const text = origin.kind === 'ready' ? origin.origin.name : origin.kind === 'locating' ? copy.findingYou : copy.yourLocation;
  invariant(text.length > 0, 'the From line says something');
  return text;
}

/** What the legs call the trip's ends, and the stations by key. */
function placeNames(origin: OriginState, destination: RecentPlace | null, stations: readonly StationListing[]): PlaceNames {
  invariant(stations.every((station) => station.name.length > 0), 'every station is named');
  const names: PlaceNames = {
    origin: origin.kind === 'ready' ? origin.origin.name : copy.yourLocation,
    destination: destination === null ? copy.routeTo : destination.name,
    stations: new Map(stations.map((station) => [station.stationKey, station.name])),
  };
  invariant(names.stations.size <= stations.length, 'each station is named once');
  return names;
}

type PlanBodyProps = {
  readonly origin: OriginState;
  readonly destination: RecentPlace | null;
  readonly plan: PlanState;
  readonly options: readonly RouteOption[];
  readonly network: RouteNetwork;
  readonly names: PlaceNames;
  readonly clock: (epoch: number) => string;
  readonly nowS: number;
  /** Told whether one option's legs are open (the sheet holds its re-plan while the rider reads them). */
  readonly onDetail?: (open: boolean) => void;
};

/** The option whose legs are open: by its id within the one answer it belongs to (a new answer closes it). */
type Selection = { readonly itineraries: readonly Itinerary[]; readonly id: number };

/** Under the fields: nothing yet, a wait, the options (or one option's legs), or Apple Maps instead. */
export function PlanBody({ origin, destination, plan, options, network, names, clock, nowS, onDetail }: PlanBodyProps) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const answer = plan.kind === 'ok' ? plan.itineraries : null;
  const open = selected !== null && selected.itineraries === answer ? options.find((option) => option.id === selected.id) : undefined;
  const reading = open !== undefined;
  useEffect(() => onDetail?.(reading), [onDetail, reading]);
  invariant(destination !== null || plan.kind === 'idle', 'options are for a destination');
  invariant(Number.isFinite(nowS), 'the body is drawn at an instant');
  if (destination === null) {
    return null;
  }
  if (origin.kind === 'failed') {
    return <PlanUnavailable reason={origin.message} destination={destination} />;
  }
  // An answer's direct walks are options too (mfix7), so an ok answer with none had no itinerary AND no walk.
  if (plan.kind === 'unavailable' || (plan.kind === 'ok' && options.length === 0)) {
    return <PlanUnavailable reason={plan.kind === 'unavailable' ? plan.reason : copy.noRoutes} destination={destination} />;
  }
  if (origin.kind === 'locating' || answer === null) {
    return <Waiting text={origin.kind === 'locating' ? copy.findingYou : copy.findingRoutes} />;
  }
  return open === undefined ? (
    <RouteOptionsList options={options} clock={clock} nowS={nowS} onSelect={(id) => setSelected({ itineraries: answer, id })} />
  ) : (
    <ItineraryDetail option={open} network={network} names={names} clock={clock} onBack={() => setSelected(null)} />
  );
}

function Waiting({ text }: { readonly text: string }) {
  invariant(text.length > 0, 'a wait says what it waits for');
  invariant(text.endsWith('…'), 'a wait reads as ongoing');
  return (
    <View testID="plan-waiting" style={styles.waiting}>
      <ActivityIndicator />
      <TText variant="subhead" tone="secondary">
        {text}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  from: { gap: SPACING.xxs },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.md },
});
