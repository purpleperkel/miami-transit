import scheduleManifest from '@/assets/db/manifest.json';
import type { ScheduleDbState } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';

/**
 * The data version the tab bar's accessory shows (M1.18, repointed at M3.8 to the schedule DB): the
 * feed hash read from the copy the phone actually opened (its meta.feed_sha256), and the first date
 * the bundled schedule runs out (the manifest's earliest service end). While the DB opens, or if it
 * fails, the accessory says so instead. Tapping it opens Data & Settings (M8b.1), which links on to
 * Diagnostics.
 */

const SHORT_SHA_LENGTH = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type AccessoryPlacement = 'regular' | 'inline';
export type AccessoryText = { readonly text: string; readonly accessibilityLabel: string };

/** A feed hash as shown in the app: its first 8 hex digits. */
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

/** "rail to Nov 22": the mode whose bundled service runs out first, and its last service date. */
export function firstServiceEnd(): string {
  const { rail, mover } = scheduleManifest.serviceEnd;
  invariant(rail.date > 0 && mover.date > 0, 'the manifest records a service end for both modes');
  const [mode, date] = rail.date <= mover.date ? ['rail', rail.date] : ['Mover', mover.date];
  invariant(date === Math.min(rail.date, mover.date), 'the earlier end is named');
  return `${mode} to ${shortServiceDate(date)}`;
}

/** The accessory's line (full above the tab bar, short inline beside it) and its VoiceOver label. */
export function dataVersionText(state: ScheduleDbState, placement: AccessoryPlacement): AccessoryText {
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  if (state.kind === 'opening') {
    return { text: placement === 'inline' ? 'Schedule…' : 'Opening schedule · Settings', accessibilityLabel: 'Schedule data opening. Opens Data & Settings.' };
  }
  if (state.kind === 'failed') {
    const accessibilityLabel = `Schedule data unavailable: ${state.message}. Opens Data & Settings.`;
    return { text: placement === 'inline' ? 'No schedule' : 'No schedule · Settings', accessibilityLabel };
  }
  const feed = shortFeedHash(state.repo.meta.feedSha256);
  invariant(state.repo.meta.feedSha256.startsWith(feed), 'the version names the open copy\'s feed');
  const [version, serviceEnd] = [`Data ${feed}`, firstServiceEnd()];
  const accessibilityLabel = `Schedule data ${feed}, ${serviceEnd}. Opens Data & Settings.`;
  return { text: placement === 'inline' ? version : `${version} · ${serviceEnd} · Settings`, accessibilityLabel };
}
