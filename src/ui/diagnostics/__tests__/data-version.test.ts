import manifest from '../../../../assets/db/manifest.json';
import type { ScheduleRepo } from '../../../data/schedule-repo';
import { InvariantError } from '../../../lib/invariant';
import { dataVersionText, firstServiceEnd, shortFeedHash, shortServiceDate } from '../data-version';

/** M3.8: the tab bar accessory's data version, repointed from the retired probe DB to the schedule DB the phone opened; M8b.1: it opens Data & Settings. */

/** A ready state whose open copy reports `feedSha256` in its meta. */
function ready(feedSha256: string) {
  const repo = { meta: { feedSha256, schemaVersion: 1, builderVersion: 2, timeZone: 'America/New_York' } } as unknown as ScheduleRepo;
  expect(repo.meta.feedSha256).toBe(feedSha256);
  expect(feedSha256).toMatch(/^[0-9a-f]{64}$/);
  return { kind: 'ready', repo } as const;
}

describe('data version accessory text (M3.8)', () => {
  it('ready: the open copy’s feed hash and the first service end (rail to Nov 22), full and inline', () => {
    const state = ready(manifest.feedSha256);
    const short = manifest.feedSha256.slice(0, 8);
    expect(dataVersionText(state, 'regular').text).toBe(`Data ${short} · rail to Nov 22 · Settings`);
    expect(dataVersionText(state, 'inline').text).toBe(`Data ${short}`);
    expect(dataVersionText(state, 'inline').accessibilityLabel).toBe(`Schedule data ${short}, rail to Nov 22. Opens Data & Settings.`);
  });

  it('opening and failed states say so instead of a version', () => {
    expect(dataVersionText({ kind: 'opening' }, 'regular').text).toBe('Opening schedule · Settings');
    const failed = dataVersionText({ kind: 'failed', message: 'the schedule DB did not open: disk full' }, 'inline');
    expect(failed).toEqual({ text: 'No schedule', accessibilityLabel: 'Schedule data unavailable: the schedule DB did not open: disk full. Opens Data & Settings.' });
  });

  it('service dates read as "Nov 22"; the earlier of the two modes’ ends is the one named', () => {
    expect([shortServiceDate(20261122), shortServiceDate(20261231), shortServiceDate(20270101)]).toEqual(['Nov 22', 'Dec 31', 'Jan 1']);
    expect(firstServiceEnd()).toBe('rail to Nov 22');
    expect(() => shortServiceDate(20261322)).toThrow(InvariantError);
  });

  it('a feed hash shows as its first 8 hex digits; anything else is refused', () => {
    expect(shortFeedHash(manifest.feedSha256)).toBe(manifest.feedSha256.slice(0, 8));
    expect(() => shortFeedHash('not-a-hash')).toThrow(InvariantError);
  });
});
