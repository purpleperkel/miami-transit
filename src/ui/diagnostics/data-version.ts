import scheduleManifest from '@/assets/db/manifest.json';
import type { ScheduleDbState } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';

/**
 * The data version the tab bar's accessory shows (M1.18, repointed at M3.8 to the schedule DB): the
 * feed hash read from the copy the phone actually opened (its meta.feed_sha256), and the first date
 * the bundled schedule runs out (the manifest's earliest service end). While the DB opens, or if it
 * fails, the accessory says so instead.
 */

const SHORT_SHA_LENGTH = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type AccessoryPlacement = 'regular' | 'inline';
export type AccessoryText = { readonly text: string; readonly accessibilityLabel: string };

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
    return { text: placement === 'inline' ? 'Schedule…' : 'Opening schedule · Diagnostics', accessibilityLabel: 'Schedule data opening. Opens Diagnostics.' };
  }
  if (state.kind === 'failed') {
    const accessibilityLabel = `Schedule data unavailable: ${state.message}. Opens Diagnostics.`;
    return { text: placement === 'inline' ? 'No schedule' : 'No schedule · Diagnostics', accessibilityLabel };
  }
  const feed = state.repo.meta.feedSha256;
  invariant(/^[0-9a-f]{64}$/.test(feed), 'the open copy records its feed hash');
  const [version, serviceEnd] = [`Data ${feed.slice(0, SHORT_SHA_LENGTH)}`, firstServiceEnd()];
  const accessibilityLabel = `Schedule data ${feed.slice(0, SHORT_SHA_LENGTH)}, ${serviceEnd}. Opens Diagnostics.`;
  return { text: placement === 'inline' ? version : `${version} · ${serviceEnd} · Diagnostics`, accessibilityLabel };
}
