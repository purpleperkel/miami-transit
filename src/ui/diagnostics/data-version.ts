import scheduleManifest from '@/assets/db/manifest.json';
import type { ScheduleDbState } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';
import type { LiveState } from '@/live/runtime';

import { type DataStatusKind, dataStatus, statusConditions, statusFace } from '../dataStatus';

/**
 * What the tab bar's accessory says (M1.18; R3b, after Jamie's 2026-10-01 phone check found the old
 * "Data <hash> · rail to Nov 22 · Settings" meaningless): the live status and the date the bundled
 * schedule runs out, in words — "Live · schedule to Nov 22". The live status is read from the live
 * runtime's latest published state, never polled for. While the schedule DB opens, or if it fails,
 * the accessory says so instead. Tapping it opens Data & Settings (M8b.1), where the feed's version
 * stays readable (ScheduleSection, through shortFeedHash below), and Diagnostics one tap further.
 */

const SHORT_SHA_LENGTH = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type AccessoryPlacement = 'regular' | 'inline';
export type AccessoryText = { readonly text: string; readonly accessibilityLabel: string };

/** A feed hash as shown in Data & Settings: its first 8 hex digits. */
export function shortFeedHash(sha256: string): string {
  invariant(/^[0-9a-f]{64}$/.test(sha256), 'a feed hash is 64 lowercase hex digits');
  const short = sha256.slice(0, SHORT_SHA_LENGTH);
  invariant(short.length === SHORT_SHA_LENGTH && sha256.startsWith(short), 'the short hash is the hash\'s first digits');
  return short;
}

/** A YYYYMMDD service date as "Nov 22". */
export function shortServiceDate(date: number): string {
  invariant(Number.isInteger(date) && date >= 19_700_101 && date <= 99_991_231, `${date} is a YYYYMMDD date`);
  const month = MONTHS[(Math.floor(date / 100) % 100) - 1];
  invariant(month !== undefined && date % 100 >= 1 && date % 100 <= 31, `${date} has a month 01–12 and a day 01–31`);
  return `${month} ${date % 100}`;
}

/** The mode whose bundled service runs out first, and its last service date (YYYYMMDD). */
function earliestEnd(): { readonly mode: 'rail' | 'Mover'; readonly date: number } {
  const { rail, mover } = scheduleManifest.serviceEnd;
  invariant(rail.date > 0 && mover.date > 0, 'the manifest records a service end for both modes');
  const end = rail.date <= mover.date ? { mode: 'rail' as const, date: rail.date } : { mode: 'Mover' as const, date: mover.date };
  invariant(end.date === Math.min(rail.date, mover.date), 'the earlier end is named');
  return end;
}

/** "rail to Nov 22": the mode whose bundled service runs out first, and its last service date. */
export function firstServiceEnd(): string {
  const { mode, date } = earliestEnd();
  invariant(mode === 'rail' || mode === 'Mover', 'the end belongs to a mode');
  const text = `${mode} to ${shortServiceDate(date)}`;
  invariant(text.startsWith(mode), 'the mode is named first');
  return text;
}

/** The live conditions the map's status pill also judges (dataStatus.ts); the schedule's own are said apart. */
const LIVE_KINDS: ReadonlySet<DataStatusKind> = new Set(['live', 'stale', 'offline']);
/** The longest live status the accessory gives room to, beside the schedule end. */
const MAX_WORDS = 24;

/**
 * The live status in words, from the runtime's latest published state (null until it first
 * publishes): "Checking live", "No live data" (no provider serves vehicles: no key, or the chain fell
 * back to the timetable), "Offline", "Live data failing" (3+ failures in a row), "Live", "Live · 2 min
 * old" (judged as the map's pill judges it, at the instant the latest vehicles arrived), or "No live
 * vehicles" (the feed answered with none).
 */
export function liveStatusWords(live: LiveState | null): string {
  invariant(live === null || live.status.vehicles !== undefined, 'a live state carries the vehicles chain status');
  const words = live === null ? 'Checking live' : stateWords(live);
  invariant(words.trim().length > 0 && words.length <= MAX_WORDS, 'the live status is a few words');
  return words;
}

function stateWords(live: LiveState): string {
  const status = live.status.vehicles;
  invariant(status.consecutiveFailures >= 0, 'failures are counted');
  const lastError = status.lastError;
  if (status.provider === 'none') {
    return 'No live data';
  }
  if (lastError !== null && (lastError.kind === 'network' || lastError.kind === 'timeout')) {
    return 'Offline';
  }
  if (status.failing) {
    return 'Live data failing';
  }
  if (live.vehicles === null) {
    return 'Checking live';
  }
  const inputs = { serviceEnds: scheduleManifest.serviceEnd, vehicles: live.vehicles, vehiclesStatus: status, nowS: live.vehicles.fetchedAt };
  const judged = dataStatus(statusConditions(inputs).filter((condition) => LIVE_KINDS.has(condition.kind)));
  invariant(judged.kind !== 'expired' && judged.kind !== 'expiring', 'only live conditions are judged here');
  return judged.kind === 'scheduled' ? 'No live vehicles' : statusFace(judged).text;
}

/**
 * The accessory's line (full above the tab bar, short inline beside it) and its VoiceOver label: the
 * live status and when the schedule runs out once the schedule DB is open, else the DB's state (the
 * live runtime runs only over an open DB, so until then there is no live status to say).
 */
export function dataVersionText(state: ScheduleDbState, placement: AccessoryPlacement, live: LiveState | null = null): AccessoryText {
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  invariant(live === null || live.status.vehicles !== undefined, 'a live state carries the vehicles chain status');
  if (state.kind === 'opening') {
    return { text: placement === 'inline' ? 'Schedule…' : 'Opening schedule · Settings', accessibilityLabel: 'Schedule data opening. Opens Data & Settings.' };
  }
  if (state.kind === 'failed') {
    const accessibilityLabel = `Schedule data unavailable: ${state.message}. Opens Data & Settings.`;
    return { text: placement === 'inline' ? 'No schedule' : 'No schedule · Settings', accessibilityLabel };
  }
  const [words, endDate] = [liveStatusWords(live), shortServiceDate(earliestEnd().date)];
  const accessibilityLabel = `${words}. Bundled schedule: ${firstServiceEnd()}. Opens Data & Settings.`;
  return { text: placement === 'inline' ? `${words} · to ${endDate}` : `${words} · schedule to ${endDate}`, accessibilityLabel };
}
