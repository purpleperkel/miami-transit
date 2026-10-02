import { invariant } from '../lib/invariant';

/**
 * The app's words (plan M6.1). Screens never spell user-facing text inline: they take it from here, so
 * a phrase reads the same on the station sheet, the trip card and VoiceOver. Arithmetic on times lives
 * in src/ui/format.ts; the status words (Live, Scheduled, Offline…) live with their icons in
 * src/ui/dataStatus.ts, so an icon and its word cannot drift apart.
 */

const CANCELED = 'Canceled';
const UNSCHEDULED_TRAIN = 'Unscheduled train';
/** A Stations row with nothing scheduled within the list's 3-hour horizon (station-list.ts NEXT_DEPARTURE_HORIZON_S). */
const NOTHING_SOON = 'No departures in the next 3 hours';

/** "6 min": a whole number of minutes, as departure rows and countdowns show it. */
function minutes(count: number): string {
  invariant(Number.isSafeInteger(count) && count >= 0, `minutes are a whole, non-negative count, got ${count}`);
  const text = `${count} min`;
  invariant(text.endsWith(' min'), 'a minute count reads "<n> min"');
  return text;
}

/** The trip card's hero (plan §4): "Leave in 6 min", or "Leave now" once no whole minute is left. */
function leaveIn(minutesLeft: number): string {
  invariant(Number.isSafeInteger(minutesLeft) && minutesLeft >= 0, `leave-in counts whole minutes, never negative, got ${minutesLeft}`);
  const text = minutesLeft === 0 ? 'Leave now' : `Leave in ${minutes(minutesLeft)}`;
  invariant(text.startsWith('Leave '), 'the hero always says when to leave');
  return text;
}

export type DepartureLabelParts = {
  /** The line's catalog name ("Orange Line"), or null when the trip's line is unknown. */
  readonly line: string | null;
  /** Where it goes, or null for a live-only train that names no destination. */
  readonly destination: string | null;
  /** What the row shows for its time: "4 min", "Now" or "9:05 PM". */
  readonly when: string;
  readonly canceled: boolean;
  /** The row's source word ("Live", "Scheduled") when the rows around it mix sources; otherwise null. */
  readonly source: string | null;
};

/**
 * VoiceOver's sentence for one departure row: every fact the row shows, in words (plan §4: never
 * colour alone). "Orange Line to Airport, 4 min, Live"; "Green Line to Palmetto, 9:05 PM, Canceled";
 * "Unscheduled train, 5 min" for a live-only train with neither a known line nor a destination.
 */
function departureLabel(parts: DepartureLabelParts): string {
  invariant(parts.destination === null || parts.destination.trim().length > 0, 'a destination is null or a name');
  invariant(parts.when.trim().length > 0, 'a departure says when it leaves');
  const where = parts.destination === null ? UNSCHEDULED_TRAIN : parts.destination;
  const heading = parts.destination === null ? [parts.line, UNSCHEDULED_TRAIN] : [parts.line === null ? `To ${where}` : `${parts.line} to ${where}`];
  const label = [...heading, parts.when, parts.canceled ? CANCELED : null, parts.source].filter((part) => part !== null).join(', ');
  invariant(label.includes(where) && (!parts.canceled || label.includes(CANCELED)), 'the sentence keeps where it goes and any cancellation');
  return label;
}

/** Names as one phrase: "A", "A and B", "A, B and C" (or "or" for alternatives). */
function joined(names: readonly string[], conjunction: 'and' | 'or'): string {
  invariant(names.length > 0 && names.every((name) => name.trim().length > 0), 'a phrase joins at least one name');
  const last = names[names.length - 1] as string;
  const phrase = names.length === 1 ? last : `${names.slice(0, -1).join(', ')} ${conjunction} ${last}`;
  invariant(names.every((name) => phrase.includes(name)), 'the phrase keeps every name');
  return phrase;
}

/** A direction's heading on the station sheet: "To Dadeland South", "To Palmetto or Miami International Airport". */
function toward(destinations: readonly string[]): string {
  invariant(destinations.length > 0, 'a direction goes somewhere');
  invariant(new Set(destinations).size === destinations.length, 'each destination is named once');
  return `To ${joined(destinations, 'or')}`;
}

/** The lines a station's strip draws, for VoiceOver: "Green Line and Orange Line" (never colour alone, §4). */
function lineNames(names: readonly string[]): string {
  invariant(names.length > 0, 'a strip draws at least one line');
  const phrase = joined(names, 'and');
  invariant(phrase.length > 0, 'the strip has words');
  return phrase;
}

export type StationRowLabelParts = {
  /** "Government Center, Metrorail". */
  readonly station: string;
  /** "Green Line and Orange Line". */
  readonly lines: string;
  /** "350 m", or null without a location. */
  readonly distance: string | null;
  /** Each direction's next departure: "Dadeland South, 4 min". */
  readonly departures: readonly string[];
};

/** VoiceOver's sentence for one Stations row: every fact it shows, in words. */
function stationRowLabel(parts: StationRowLabelParts): string {
  invariant(parts.station.length > 0 && parts.lines.length > 0, 'a row names its station and lines');
  const leaving = parts.departures.length === 0 ? [NOTHING_SOON] : parts.departures.map((d) => `next to ${d}`);
  const label = [parts.station, parts.lines, parts.distance === null ? null : `${parts.distance} away`, ...leaving].filter((part) => part !== null).join('; ');
  invariant(label.startsWith(parts.station), 'the sentence starts with the station');
  return label;
}

export const copy = Object.freeze({
  /** A departure due within the half minute, or leaving right now. */
  now: 'Now',
  /** A canceled departure stays listed, struck through, with this word beside it (§4 merge rule 6). */
  canceled: CANCELED,
  /** A live-only train the timetable does not list, whose prediction names no destination. */
  unscheduledTrain: UNSCHEDULED_TRAIN,
  /** A direction with nothing left to show in its window. */
  noDepartures: 'No upcoming departures',
  minutes,
  leaveIn,
  departureLabel,
  toward,
  lineNames,
  stationRowLabel,
  /** A Stations row whose directions have nothing scheduled within the list's 3-hour horizon. */
  nothingSoon: NOTHING_SOON,
  /** The station sheet footer's Apple Maps walking handoff. */
  walkDirections: 'Walk directions',
  walkDirectionsHint: 'Opens Apple Maps with walking directions to this station',
  /** Apple Maps would not open (both the app URL and its web fallback were refused). */
  mapsFailed: 'Apple Maps did not open',
  unknownStation: 'This station is not in the timetable',
  unknownStationMessage: 'It may be from an older timetable than the one this app carries.',
  /** A sheet waiting for the bundled schedule DB to open, or finding it broken. */
  scheduleOpening: 'Opening the schedule',
  sheetOpeningMessage: 'The times appear in a moment.',
  sheetUnavailable: 'Times unavailable',
  timetableExpired: 'The timetable has run out. Update the app for new times.',
  timetableNotStarted: 'The timetable does not start yet.',
  /** Location is off or refused, so the list keeps its line order. */
  noLocation: 'Location is off, so stations are listed in line order.',
  /** mfix7: the Stations tab's first section with a location, the nearest stations of any mode. */
  nearby: 'Nearby',
  /** The vehicle sheet. */
  nextStops: 'Next stops',
  scheduledTimes: 'Scheduled times',
  notRunning: 'This vehicle is not running now',
  notInTimetable: 'This vehicle is not in the timetable, so its stops are unknown',
  follow: 'Follow',
  following: 'Following',
  followHint: 'Keeps the map centered on this vehicle until you move the map',
  /** The route options sheet (M10b) and its doors. */
  directions: 'Directions',
  directionsHint: 'Shows route options to a place',
  routeFromHere: 'Route from here',
  routeFromHereHint: 'Shows route options starting at this station',
  /** The Trips tab's empty-state action (ruling R6): the route options sheet. */
  planRoute: 'Plan a route',
  planRouteHint: 'Shows route options to a place',
  routeFrom: 'From',
  routeTo: 'To',
  yourLocation: 'Your location',
  whereTo: 'Where to? A place, an address or a station',
  findingYou: 'Finding where you are…',
  routeNoLocation: 'Location is off, so route options cannot start from where you are.',
  findingRoutes: 'Finding routes…',
  noRoutes: 'No route options for this trip right now.',
  /** mfix7: a walk-only option (Transitous's direct answer, when walking beats every train), on its row and in its detail. */
  walkOnlyOption: (duration: string) => `Walk ${duration} · no train needed`,
  routesUnavailable: 'Route options unavailable',
  openInAppleMaps: 'Open in Apple Maps',
  openInAppleMapsHint: 'Opens Apple Maps with transit directions to this place',
  legDirectionsHint: 'Opens Apple Maps with walking directions for this part of the trip',
  allOptions: 'All options',
  allOptionsHint: 'Goes back to every route option',
  optionHint: 'Shows each leg, with walking directions',
  transitousSourcesHint: 'Opens the data sources Transitous routes on',
  osmCopyrightHint: 'Opens the OpenStreetMap copyright page',
  recentPlaces: 'Recent',
  stationPlaces: 'Stations',
  stationDetail: Object.freeze({ rail: 'Metrorail station', mover: 'Metromover station' }),
  searchPlace: (words: string) => `Search for “${words}”`,
  noPlaceFound: (words: string) => `No place found for “${words}”`,
  searchFailed: 'The search did not work',
  recentNotSaved: 'Not saved to recent places',
  /** mfix5 (arbiter ruling 2026-10-02): a late leg's delay overruns a transfer's slack; the next ride does not wait. */
  tightTransfer: (line: string) => `Tight transfer · may miss ${line}`,
  /** A web page (an attribution's source) would not open. */
  pageFailed: 'The page did not open',
});
