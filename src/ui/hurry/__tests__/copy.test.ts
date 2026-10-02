import { type HurryVerdict, hurryVerdict } from '../../../domain/hurry/verdict';
import { actionableVerdict, type HurryCopyContext, hurryCopy, hurryInline, hurryParts, hurrySentence, INLINE_MAX_CHARS } from '../copy';

/**
 * Plan M7c.2 / M7c.3: the verdict's words, byte-exact (U+00B7 middle dots), on verdicts made by the real
 * engine at now 0 (400 m away unless said: walk ≈ 385.2 s, jog ≈ 192.6 s). The clock is injected — the
 * 300 s train reads "2:14", the 900 s one "2:26" — so the copy never does time-zone math.
 */

const CLOCK: Readonly<Record<number, string>> = { 300: '2:14', 900: '2:26' };
const CTX: HurryCopyContext = { now: 0, clock: (epoch) => CLOCK[epoch] ?? '9:59' };

/** The engine's verdict for trains at `epochs`, `walkMeters` from the platform. */
function verdict(epochs: readonly number[], walkMeters = 400, live = false): HurryVerdict {
  const made = hurryVerdict({ now: 0, walkMeters, departures: epochs.map((epoch) => ({ epoch, live, lineId: 'GREEN', headsign: 'Dadeland South' })) });
  expect(made.walkS).toBeCloseTo((walkMeters * 1.3) / 1.35, 6);
  expect(made.live).toBe(live && epochs.length > 0);
  return made;
}

/** Every kind of verdict, the long and the extreme included. */
function everyVerdict(): Readonly<Record<string, HurryVerdict>> {
  const all = {
    chill: verdict([600]),
    twoHourChill: verdict([7200]),
    underAMinuteChill: verdict([420]),
    jog: verdict([300, 1200]),
    notWorthIt: verdict([300, 500]),
    missed: verdict([150, 900]),
    missedThenJog: verdict([150, 300]),
    missedThenNotWorthIt: verdict([100, 300, 400]),
    allMissed: verdict([100, 110, 120, 2000]),
    noService: verdict([]),
  };
  expect(Object.values(all).map((v) => v.kind)).toEqual(['CHILL', 'CHILL', 'CHILL', 'JOG', 'NOT_WORTH_IT', 'MISSED', 'MISSED', 'MISSED', 'MISSED', 'NO_SERVICE']);
  expect(all.missedThenNotWorthIt.nested?.kind).toBe('NOT_WORTH_IT');
  return all;
}

describe('the hurry copy (M7c.2)', () => {
  it('CHILL reads Chill 3 min to spare', () => {
    expect(hurryCopy(verdict([600]), CTX)).toBe('Chill · 3 min to spare');
    expect(hurryParts(verdict([600]), CTX)).toEqual({ headline: 'Chill', detail: '3 min to spare' });
  });

  it('JOG reads Jog makes the 2:14 with 1 min spare', () => {
    expect(hurryCopy(verdict([300, 1200]), CTX)).toBe('Jog · makes the 2:14 with 1 min spare');
    expect(hurryParts(verdict([300, 1200]), CTX).headline).toBe('Jog');
  });

  it('NOT_WORTH_IT reads Not worth it next in 3 min', () => {
    // 100 m away the 100 s train is jog-catchable, but the 180 s train is only 80 s behind it.
    const v = verdict([100, 180], 100);
    expect(v.kind).toBe('NOT_WORTH_IT');
    expect(hurryCopy(v, CTX)).toBe('Not worth it · next in 3 min');
  });

  it('MISSED reads Missed next 2:26 chill', () => {
    expect(hurryCopy(verdict([150, 900]), CTX)).toBe('Missed · next 2:26 · chill');
    expect(hurryCopy(verdict([150, 300]), CTX)).toBe('Missed · next 2:14 · jog');
  });

  it('NO_SERVICE reads No more trains tonight', () => {
    expect(hurryCopy(verdict([]), CTX)).toBe('No more trains tonight');
    expect(hurryParts(verdict([]), CTX).detail).toBeNull();
  });

  it('rounds minutes down and says so below one', () => {
    expect(hurryCopy(verdict([420]), CTX)).toBe('Chill · under 1 min to spare');
    expect(hurryCopy(verdict([100, 110, 120, 2000]), CTX)).toBe('Missed · nothing you can make soon');
  });
});

describe('the Now strip inline copy (M7c.3, ruling R1)', () => {
  it('inline JOG reads Jog 1 min', () => {
    expect(hurryInline(verdict([300, 1200]), CTX)).toBe('Jog · 1 min');
    expect(hurryInline(verdict([600]), CTX)).toBe('Chill · 3 min');
  });

  it('inline text is at most 14 characters', () => {
    expect(INLINE_MAX_CHARS).toBe(14);
    const wide: HurryCopyContext = { now: 0, clock: () => '12:59' };
    const inline = Object.fromEntries(Object.entries(everyVerdict()).map(([name, v]) => [name, hurryInline(v, wide)]));
    expect(Object.values(inline).filter((text) => [...text].length > INLINE_MAX_CHARS || text.trim().length === 0)).toEqual([]);
    // The two-hour wait shortens to hours; a missed train names what to do about the next one.
    expect([inline.twoHourChill, inline.missed, inline.allMissed, inline.noService]).toEqual(['Chill · 1 h', 'Chill · 12:59', 'Missed', 'No more trains']);
  });
});

describe('the VoiceOver sentence (M7c.2)', () => {
  it('VoiceOver sentence says live or scheduled', () => {
    expect(hurrySentence(verdict([600], 400, true), CTX)).toBe('Chill, a walk makes the 9:59 train with 3 minutes to spare, going by live times.');
    expect(hurrySentence(verdict([600]), CTX)).toBe('Chill, a walk makes the 9:59 train with 3 minutes to spare, going by scheduled times.');
    for (const v of Object.values(everyVerdict())) {
      const sentence = hurrySentence(v, CTX);
      expect([sentence, /^[A-Z][^·]*\.$/.test(sentence), /\b(live|scheduled)\b/.test(sentence)]).toEqual([sentence, true, true]);
    }
  });

  it('a missed train speaks of the one after it', () => {
    expect(hurrySentence(verdict([150, 900]), CTX)).toBe('You will miss the 9:59 train, but a walk makes the 2:26 train with 8 minutes to spare, going by scheduled times.');
    expect(actionableVerdict(verdict([150, 900])).departure?.epoch).toBe(900);
  });
});
