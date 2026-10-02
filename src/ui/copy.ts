import { invariant } from '../lib/invariant';

/**
 * The app's words (plan M6.1). Screens never spell user-facing text inline: they take it from here, so
 * a phrase reads the same on the station sheet, the trip card and VoiceOver. Arithmetic on times lives
 * in src/ui/format.ts; the status words (Live, Scheduled, Offline…) live with their icons in
 * src/ui/dataStatus.ts, so an icon and its word cannot drift apart.
 */

const CANCELED = 'Canceled';
const UNSCHEDULED_TRAIN = 'Unscheduled train';

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
});
