import type { StationListing } from '../../data/schedule-queries';
import type { HurryVerdict } from '../../domain/hurry/verdict';
import { type LineId, lineById } from '../../domain/lines/line-catalog';
import type { LiveBatch, LiveNetwork, LivePrediction } from '../../domain/live/types';
import { type FirstLegPace, firstLegVerdict, gtfsStopId, gtfsTripId } from '../../domain/routes/overlay';
import { isWalkOnly, type Itinerary, type Leg, type LegPlace } from '../../domain/routes/transitous';
import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { copy } from '../copy';
import { formatMinutes } from '../format';
import { clockFor } from '../hurry/hurry-reading';

/**
 * Plan M10b.1, the route options sheet's pure half: Transitous's itineraries (m10a, already corrected by
 * the live overlay) as the rows a rider scans at a glance —
 *
 *   2:01 → 2:21     20 min · No transfers · 13 min walk     [Brickell] [Live]     Chill · 1 min spare
 *
 * sorted by ARRIVAL (the question is "when do I get there?"), each with its line badges, a Live badge when
 * any leg runs on a live prediction, and hurry or chill for the FIRST transit leg — m7c's engine through
 * m10a's firstLegVerdict, walking to the boarding stop at Jamie's paces from the rider when located, else
 * from the plan's start — for every plan, "Route from here" (mfix5) or from the rider's own location (mfix8;
 * OptionContext.position, use-route-plan.ts useChipPosition). A late leg that may cost a connection says so
 * on its row: "Tight transfer · may miss 26".
 *
 * The chip's walk (mfix8, Jamie: "it seems to say chill when the walk is 11 min and train leaves in 2"):
 * while the rider is still within CHIP_ROUTED_START_M of where the itinerary starts, the walk is the one
 * Transitous ROUTED along the streets to the boarding stop (its walk legs' metres, no detour factor).
 * Otherwise — the rider has moved on, so the routed legs no longer start where they are — or when no walk leg
 * with a distance comes before the first ride, it is the straight line from the rider (× m7c's 1.3 detour).
 *
 * A leg's line comes from the bundled schedule: Transitous's trip id carries the county's GTFS trip_id,
 * and the schedule knows each trip's line by its stop pattern (m3a), so the Orange train and the Brickell
 * loop get their real badges. A leg the schedule does not know (a bus) shows its route's short name.
 * Stops the schedule knows are named as the app names its stations ("Government Center"), not by
 * Transitous's platform names ("GOVERNMENT CTR.STAT.RAIL SOUTHBOUND").
 *
 * Clock times come from the schedule's service-day bases (no time-zone math on the phone, plan §4); while
 * the schedule is still opening, or has no running day, a time reads relative to now ("in 6 min").
 */

/** What the options read from the schedule: a trip's line and a stop's station (the live runtime's network fits). */
export type RouteNetwork = Pick<LiveNetwork, 'lineOfTrip' | 'stationOfStop'>;

/** A network that knows nothing: the options before the schedule DB opens. */
export const NO_ROUTE_NETWORK: RouteNetwork = Object.freeze({ lineOfTrip: () => null, stationOfStop: () => null });

/** A transit leg's badge: a catalog line (m6a's LineBadge), or a route the catalog does not have ("26"). */
export type LegBadge = { readonly kind: 'line'; readonly lineId: LineId } | { readonly kind: 'route'; readonly text: string; readonly label: string };

export type RouteOption = {
  /** The itinerary's place in Transitous's answer: stable while the live overlay and the clock move the rows. */
  readonly id: number;
  readonly itinerary: Itinerary;
  /** When to set off (the itinerary's start), epoch s. */
  readonly departEpoch: number;
  /** When it gets there, epoch s: the sort key. */
  readonly arriveEpoch: number;
  readonly durationS: number;
  readonly transfers: number;
  /** Seconds on foot across every walk leg. */
  readonly walkS: number;
  /** One badge per transit leg, in order. */
  readonly badges: readonly LegBadge[];
  /** Some leg's boarding departure is a live prediction (m10a's overlay). */
  readonly live: boolean;
  /** Hurry or chill for the first transit leg; null for a walk-only option or without a start position. */
  readonly verdict: HurryVerdict | null;
  /** "Tight transfer · may miss 26" when a late leg may cost the connection (m10a's overlay flag), else null. */
  readonly connectionAtRisk: string | null;
};

/** What the hurry chip is computed from: the plan's start, now, and Jamie's paces (m8b). */
export type OptionContext = { readonly position: LatLon | null; readonly nowS: number; readonly pace: FirstLegPace };

/** An epoch as the rows show it ("2:01", or "in 6 min" without service-day bases). */
export type RouteClock = (epoch: number) => string;

export type OptionFacts = {
  readonly times: string;
  readonly duration: string;
  readonly transfers: string;
  readonly walk: string;
  /** A walk-only option (Transitous's direct answer, mfix7) in one line, "Walk 8 min · no train needed"; null for a ride. */
  readonly walkOnly: string | null;
};

/** At most this many boarding stations are watched for live predictions while the sheet is open (REALTIME COST RULE). */
export const MAX_WATCHED_STATIONS = 3;

/**
 * The hurry chip walks Transitous's routed legs only while the rider is within this many metres of where
 * the itinerary starts (arbiter ruling, mfix8: a phone's fix jitters ~10-20 m when standing still).
 */
export const CHIP_ROUTED_START_M = 50;

const MODE_WORDS: Readonly<Record<string, string>> = { BUS: 'Bus', TRAM: 'Tram', SUBWAY: 'Subway', RAIL: 'Rail', REGIONAL_RAIL: 'Rail', COACH: 'Coach', FERRY: 'Ferry' };

/** The options for `itineraries`, earliest arrival first (a tie leaves later, then changes less). */
export function routeOptions(itineraries: readonly Itinerary[], network: RouteNetwork, context: OptionContext): RouteOption[] {
  invariant(Number.isFinite(context.nowS), 'the options are read at an instant');
  invariant(context.position === null || isLatLon(context.position), 'the start is a real coordinate, or unknown');
  const options = itineraries.map((itinerary, id) => optionOf(id, itinerary, network, context));
  options.sort((a, b) => a.arriveEpoch - b.arriveEpoch || b.departEpoch - a.departEpoch || a.transfers - b.transfers);
  invariant(options.every((option, i) => i === 0 || (options[i - 1] as RouteOption).arriveEpoch <= option.arriveEpoch), 'the options are sorted by arrival');
  return options;
}

function optionOf(id: number, itinerary: Itinerary, network: RouteNetwork, context: OptionContext): RouteOption {
  invariant(Number.isSafeInteger(id) && id >= 0 && itinerary.legs.length > 0, 'an itinerary has a place in the answer, and legs');
  const walkS = itinerary.legs.filter((leg) => leg.mode === 'WALK').reduce((sum, leg) => sum + leg.durationS, 0);
  const badges = itinerary.legs.map((leg) => legBadge(leg, network)).filter((badge): badge is LegBadge => badge !== null);
  const position = context.position;
  const verdict = position === null ? null : firstLegVerdict(itinerary, position, context.nowS, context.pace, isAtStart(itinerary, position));
  const option: RouteOption = {
    id,
    itinerary,
    departEpoch: itinerary.startEpoch,
    arriveEpoch: itinerary.endEpoch,
    durationS: itinerary.durationS,
    transfers: itinerary.transfers,
    walkS,
    badges,
    live: itinerary.legs.some((leg) => leg.live),
    verdict,
    connectionAtRisk: connectionRiskText(itinerary, network),
  };
  invariant(option.walkS >= 0 && option.badges.length <= itinerary.legs.length, 'an option walks a non-negative time and badges at most every leg');
  return option;
}

/** The rider is still where the itinerary starts (within CHIP_ROUTED_START_M of its first leg's from-place). */
function isAtStart(itinerary: Itinerary, position: LatLon): boolean {
  const start = itinerary.legs[0];
  invariant(start !== undefined && isLatLon(position), 'an itinerary starts somewhere, and the rider is somewhere');
  const metres = haversineMeters(position, { latitude: start.from.latitude, longitude: start.from.longitude });
  invariant(Number.isFinite(metres) && metres >= 0, 'a distance is a non-negative number of metres');
  return metres <= CHIP_ROUTED_START_M;
}

/** The overlay's missed-connection flag in words, naming the ride as its badge does ("26", "Orange Line"); null when the transfers hold. */
export function connectionRiskText(itinerary: Itinerary, network: RouteNetwork): string | null {
  const risk = itinerary.connectionAtRisk;
  if (risk === undefined) {
    return null;
  }
  const leg = itinerary.legs[risk.legIndex];
  invariant(leg !== undefined && leg.tripId !== null, `the connection at risk is a ride of the itinerary, leg ${risk.legIndex}`);
  const badge = legBadge(leg, network);
  const line = badge === null ? risk.line : badge.kind === 'line' ? lineById(badge.lineId).name : badge.text;
  const text = copy.tightTransfer(line);
  invariant(line.length > 0 && text.endsWith(line), 'the warning names the line that may be missed');
  return text;
}

/** A leg's badge: its catalog line when the schedule knows its trip, its route name otherwise; null for a walk. */
export function legBadge(leg: Leg, network: RouteNetwork): LegBadge | null {
  invariant(leg.mode.length > 0, 'a leg has a mode');
  if (leg.tripId === null) {
    return null;
  }
  const lineId = network.lineOfTrip(gtfsTripId(leg.tripId));
  const word = modeWord(leg.mode);
  const text = leg.routeShortName ?? word;
  const badge: LegBadge = lineId !== null ? { kind: 'line', lineId } : { kind: 'route', text, label: text === word ? word : `${word} ${text}` };
  invariant(badge.kind === 'line' || badge.text.length > 0, 'a route badge has words');
  return badge;
}

/** What VoiceOver reads for a badge: the line's catalog name ("Orange Line"), or "Bus 26". */
export function badgeLabel(badge: LegBadge): string {
  invariant(badge.kind === 'line' || badge.label.length > 0, 'a badge can be named');
  const label = badge.kind === 'line' ? lineById(badge.lineId).name : badge.label;
  invariant(label.trim().length > 0, 'a badge reads as words');
  return label;
}

/** A MOTIS mode as a word ("BUS" → "Bus"); an unlisted mode in sentence case. */
export function modeWord(mode: string): string {
  invariant(mode.length > 0, 'a mode is named');
  const word = MODE_WORDS[mode] ?? `${mode.charAt(0)}${mode.slice(1).toLowerCase().replace(/_/g, ' ')}`;
  invariant(word.length > 0, 'a mode reads as a word');
  return word;
}

/** When an option leaves without the rider: its first ride's (live or scheduled) departure; a walk-only option's start. */
export function optionLeavesS(option: RouteOption): number {
  const ride = option.itinerary.legs.find((leg) => leg.tripId !== null);
  const leavesS = ride === undefined ? option.departEpoch : ride.from.epoch;
  invariant(Number.isFinite(leavesS), 'an option leaves at an instant');
  invariant(leavesS <= option.arriveEpoch, 'an option leaves before it arrives');
  return leavesS;
}

/** The row's words: "2:01 → 2:21", "20 min", "No transfers", "13 min walk" — or, on foot only, "Walk 8 min · no train needed". */
export function optionFacts(option: RouteOption, clock: RouteClock): OptionFacts {
  invariant(option.arriveEpoch >= option.departEpoch, 'an option arrives after it departs');
  const walkMinutes = Math.ceil(option.walkS / 60);
  const facts: OptionFacts = {
    times: `${clock(option.departEpoch)} → ${clock(option.arriveEpoch)}`,
    duration: durationText(option.durationS),
    transfers: option.transfers === 0 ? 'No transfers' : option.transfers === 1 ? '1 transfer' : `${option.transfers} transfers`,
    walk: walkMinutes === 0 ? 'No walking' : `${walkMinutes} min walk`,
    walkOnly: isWalkOnly(option.itinerary) ? copy.walkOnlyOption(durationText(option.walkS)) : null,
  };
  invariant(Object.values(facts).every((text) => text === null || text.length > 0), 'every fact says something');
  invariant(facts.walkOnly === null || (option.verdict === null && !option.live && option.badges.length === 0), 'a walk-only option has no hurry chip, no Live badge and no line badge');
  return facts;
}

/** A trip length: "20 min", "1 h", "1 h 5 min" (minutes rounded up: never promise a shorter trip). */
export function durationText(seconds: number): string {
  invariant(Number.isFinite(seconds) && seconds >= 0, `a duration is a non-negative number of seconds, got ${seconds}`);
  const minutes = Math.ceil(seconds / 60);
  const text = minutes < 60 ? `${minutes} min` : minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  invariant(/^(\d+ h)?( ?\d+ min)?$/.test(text) && text.length > 0, `"${text}" reads as a duration`);
  return text;
}

/** The rows' clock: service-day bases when the schedule has a running day, else minutes from now. */
export function routeClock(bases: readonly number[] | null, nowS: number): RouteClock {
  invariant(Number.isFinite(nowS), 'a clock is read at an instant');
  invariant(bases === null || bases.every((base) => Number.isSafeInteger(base)), 'bases are whole epoch seconds');
  return bases !== null && bases.length > 0 ? clockFor(bases) : (epoch) => (epoch - nowS < 30 ? 'now' : `in ${formatMinutes((epoch - nowS) * 1000)}`);
}

/** The names a leg's ends show: the plan's own start and end for the outer ends, a station name, or Transitous's. */
export type PlaceNames = { readonly origin: string; readonly destination: string; readonly stations: ReadonlyMap<string, string> };

/** Leg `index` of `itinerary`: where it starts and ends, as the rider calls those places. */
export function legEnds(itinerary: Itinerary, index: number, network: RouteNetwork, names: PlaceNames): { readonly from: string; readonly to: string } {
  const leg = itinerary.legs[index];
  invariant(leg !== undefined, `the itinerary has a leg ${index}`);
  const from = index === 0 && leg.from.stopId === null ? names.origin : placeName(leg.from, network, names);
  const to = index === itinerary.legs.length - 1 && leg.to.stopId === null ? names.destination : placeName(leg.to, network, names);
  invariant(from.length > 0 && to.length > 0, 'both ends of a leg are named');
  return { from, to };
}

function placeName(place: LegPlace, network: RouteNetwork, names: PlaceNames): string {
  invariant(place.name.length > 0 || place.stopId !== null, 'a place has a name or a stop');
  const stationKey = place.stopId === null ? null : network.stationOfStop(gtfsStopId(place.stopId));
  const name = (stationKey === null ? undefined : names.stations.get(stationKey)) ?? place.name;
  invariant(name.length > 0, 'a place is named');
  return name;
}

/**
 * What saving an option as a trip would save (mfix8, Jamie: "I don't see how to save a route"). A saved trip is
 * m7b's ONE Metrorail or Metromover ride between two stations, so an option with exactly one ride whose stops the
 * schedule knows saves as that ride's boarding → alighting stations; any other option says why it cannot.
 */
export type TripToSave =
  | { readonly kind: 'ride'; readonly from: string; readonly to: string }
  /** Two or more rides: a saved trip is one. */
  | { readonly kind: 'rides'; readonly rides: number }
  /** One ride the schedule does not know both ends of (a bus), or one that gets off where it boarded. */
  | { readonly kind: 'not-stations' }
  /** No ride at all: a walk is not a trip. */
  | { readonly kind: 'walk' };

export function tripToSave(itinerary: Itinerary, network: RouteNetwork): TripToSave {
  invariant(itinerary.legs.length > 0, 'an itinerary has legs');
  const rides = itinerary.legs.filter((leg) => leg.tripId !== null);
  const ride = rides[0];
  if (ride === undefined) {
    return { kind: 'walk' };
  }
  if (rides.length > 1) {
    return { kind: 'rides', rides: rides.length };
  }
  const from = ride.from.stopId === null ? null : network.stationOfStop(gtfsStopId(ride.from.stopId));
  const to = ride.to.stopId === null ? null : network.stationOfStop(gtfsStopId(ride.to.stopId));
  const save: TripToSave = from === null || to === null || from === to ? { kind: 'not-stations' } : { kind: 'ride', from, to };
  invariant(save.kind !== 'ride' || (save.from.includes(':') && save.to.includes(':')), 'a saved ride joins two stations keyed mode:name');
  return save;
}

/** The stations whose live predictions can correct these itineraries: rail and Mover boarding stops, earliest-arriving first. */
export function boardingStations(itineraries: readonly Itinerary[], network: RouteNetwork): string[] {
  invariant(itineraries.every((itinerary) => itinerary.legs.length > 0), 'every itinerary has legs');
  const keys: string[] = [];
  const byArrival = [...itineraries].sort((a, b) => a.endEpoch - b.endEpoch);
  for (const leg of byArrival.flatMap((itinerary) => itinerary.legs)) {
    const key = leg.tripId === null || leg.from.stopId === null ? null : network.stationOfStop(gtfsStopId(leg.from.stopId));
    if (key !== null && !keys.includes(key) && keys.length < MAX_WATCHED_STATIONS) {
      keys.push(key);
    }
  }
  invariant(keys.length <= MAX_WATCHED_STATIONS && new Set(keys).size === keys.length, 'a few stations, each once');
  return keys;
}

/** The watched stations' latest predictions, in one list for the overlay. */
export function predictionsAt(batches: ReadonlyMap<string, LiveBatch<LivePrediction>> | null, stationKeys: readonly string[]): LivePrediction[] {
  invariant(new Set(stationKeys).size === stationKeys.length, 'each station is read once');
  const predictions = stationKeys.flatMap((key) => batches?.get(key)?.items ?? []);
  invariant(batches !== null || predictions.length === 0, 'no live state, no predictions');
  return predictions;
}

/** A place the "To" field offers: a recent place or a station, with what kind it is. */
export type PlaceSuggestion = { readonly name: string; readonly detail: string | null; readonly lat: number; readonly lon: number };

/** The stations whose names contain `query` (case-insensitive), at most `max`, as destinations. */
export function stationSuggestions(query: string, stations: readonly StationListing[], max: number): PlaceSuggestion[] {
  invariant(Number.isSafeInteger(max) && max > 0, 'suggestions are capped');
  const needle = query.trim().toLowerCase();
  const found = needle.length === 0 ? [] : stations.filter((station) => station.name.toLowerCase().includes(needle)).slice(0, max);
  const suggestions = found.map(stationPlace);
  invariant(suggestions.length <= max, 'at most max suggestions');
  return suggestions;
}

/** A station as a destination: its name, its system, its coordinate. */
function stationPlace(station: StationListing): PlaceSuggestion {
  invariant(isLatLon(station.coordinate), `${station.stationKey} has a real coordinate`);
  const place = { name: station.name, detail: copy.stationDetail[station.mode], lat: station.coordinate.latitude, lon: station.coordinate.longitude };
  invariant(place.name.length > 0 && place.detail.length > 0, 'a station suggestion is named, with its system');
  return place;
}

/** What is handed to the geocoder: the rider's words, placed in Miami-Dade unless they already name Florida. */
export function geocodeQuery(text: string): string {
  const words = text.trim();
  invariant(words.length > 0, 'a search has words');
  const query = /\b(FL|Florida)\b/i.test(words) ? words : `${words}, Miami-Dade County, FL`;
  invariant(query.startsWith(words), 'the rider\'s words come first');
  return query;
}
