import { type HurryVerdict, hurryVerdict } from '../../../domain/hurry/verdict';
import { type HurryCopyContext, hurryInline, hurryShort } from '../copy';

/**
 * mfix8 (Jamie, 2026-10-02: "it seems to say chill when the walk is 11 min and train leaves in 2"): every number
 * the route chip and the Now bar show says what it counts — "3 min spare", "next in 3 min", "next 2:26" — and the
 * inline text, with no room for a label, shows no bare number at all. Verdicts come from the real engine at now
 * 0 (400 m away unless said); the 300 s train reads "2:14", the 900 s one "2:26", any other "12:59".
 */

const CLOCK: Readonly<Record<number, string>> = { 300: '2:14', 900: '2:26' };
const CTX: HurryCopyContext = { now: 0, clock: (epoch) => CLOCK[epoch] ?? '12:59' };

/** A number with what it counts: minutes of spare time, minutes to the next train, or the next train's clock time. */
const LABELLED_NUMBER = /(\d+|under 1) min spare|next in \d+ min|[Nn]ext \d{1,2}:\d{2}/g;

/** The engine's verdict for trains at `epochs`, `walkMeters` from the platform. */
function verdict(epochs: readonly number[], walkMeters = 400): HurryVerdict {
  const made = hurryVerdict({ now: 0, walkMeters, departures: epochs.map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: 'Dadeland South' })) });
  expect(made.walkS).toBeCloseTo((walkMeters * 1.3) / 1.35, 6);
  expect(made.departure === null || epochs.includes(made.departure.epoch)).toBe(true);
  return made;
}

/** Every verdict over a spread of walks and timetables: each kind, short and two-hour waits, nested or not. */
function everyVerdict(): HurryVerdict[] {
  const timetables = [[600], [450], [7200], [300, 1200], [100, 180], [300, 500], [150, 900], [150, 300], [100, 300, 400], [100, 110, 120, 2000], []];
  const all = [0, 100, 400, 1500, 2000].flatMap((walkMeters) => timetables.map((epochs) => verdict(epochs, walkMeters)));
  expect(new Set(all.map((v) => v.kind))).toEqual(new Set(['CHILL', 'JOG', 'NOT_WORTH_IT', 'MISSED', 'NO_SERVICE']));
  expect(all.some((v) => v.kind === 'MISSED' && v.nested !== null) && all.some((v) => v.kind === 'MISSED' && v.nested === null)).toBe(true);
  return all;
}

describe('the labelled short copy and the inline word (mfix8)', () => {
  it('every verdict number is labelled', () => {
    const table: readonly (readonly [HurryVerdict, string, string])[] = [
      [verdict([600]), 'Chill · 3 min spare', 'Chill'],
      [verdict([450]), 'Chill · under 1 min spare', 'Chill'],
      [verdict([300, 1200]), 'Jog · 1 min spare', 'Jog'],
      [verdict([100, 180], 100), 'Not worth it · next in 3 min', 'Not worth it'],
      [verdict([150, 900]), 'Missed · next 2:26', 'Next 2:26'],
      [verdict([100, 110, 120, 2000]), 'Missed · nothing soon', 'Missed'],
      [verdict([]), 'No more trains tonight', 'No more trains'],
    ];
    expect(table.map(([v]) => [v.kind, hurryShort(v, CTX), hurryInline(v, CTX)])).toEqual(table.map(([v, short, inline]) => [v.kind, short, inline]));
    // Beyond the table: whatever the engine says, a digit appears only inside a labelled number.
    const said = everyVerdict().flatMap((v) => [hurryShort(v, CTX), hurryInline(v, CTX)]);
    expect(said.filter((text) => /\d/.test(text.replace(LABELLED_NUMBER, '')))).toEqual([]);
    expect(said.filter((text) => /^(Chill|Jog|Not worth it)$/.test(text)).length).toBeGreaterThan(0);
  });
});
