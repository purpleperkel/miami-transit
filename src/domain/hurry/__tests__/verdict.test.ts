import { HURRY_DEFAULTS, type HurryDeparture, type HurryInput, hurryVerdict, MAX_JUDGED } from '../verdict';

/**
 * Plan M7c.1: the hurry-or-chill verdict on the plan's numbers. With now 0 and 400 m to the platform,
 * the defaults (detour 1.3, walk 1.35 m/s, jog 2.7 m/s) give walkS = 520 / 1.35 ≈ 385.2 s and
 * jogS = 520 / 2.7 ≈ 192.6 s; a departure's slack is its epoch − now − 30 s (boardBufferS).
 */

const WALK_S = (400 * 1.3) / 1.35;
const JOG_S = (400 * 1.3) / 2.7;

/** A scheduled departure (live and stale on request) at `epoch`. */
function dep(epoch: number, live = false, stale?: boolean): HurryDeparture {
  const departure: HurryDeparture = { epoch, live, lineId: 'GREEN', headsign: 'Dadeland South', ...(stale === undefined ? {} : { stale }) };
  expect(departure.epoch).toBe(epoch);
  expect(departure.live).toBe(live);
  return departure;
}

/** The verdict at now 0, 400 m away, for departures at `epochs` (with any setting overridden). */
function verdictFor(epochs: readonly number[], settings: Partial<HurryInput> = {}) {
  const input: HurryInput = { now: 0, walkMeters: 400, departures: epochs.map((epoch) => dep(epoch)), ...settings };
  expect(input.departures.map((d) => d.epoch)).toEqual(input.departures.map((d) => d.epoch).sort((a, b) => a - b));
  const verdict = hurryVerdict(input);
  expect(verdict.walkS).toBeGreaterThan(0);
  return verdict;
}

describe('the hurry verdict (M7c.1 A)', () => {
  it('dep 600 is CHILL with 184.8 s to spare', () => {
    const verdict = verdictFor([600]);
    expect(verdict.kind).toBe('CHILL');
    expect(verdict.departure?.epoch).toBe(600);
    expect(verdict.spareS).toBeCloseTo(184.8, 1);
    expect(verdict.walkS).toBeCloseTo(385.2, 1);
    expect(verdict.jogS).toBeCloseTo(192.6, 1);
    // Unrounded: the copy rounds, the engine never does.
    expect(verdict.spareS).toBe(570 - WALK_S);
  });

  it('dep 300 then 1200 is JOG with 77.4 s to spare', () => {
    const verdict = verdictFor([300, 1200]);
    expect(verdict.kind).toBe('JOG');
    expect(verdict.departure?.epoch).toBe(300);
    expect(verdict.spareS).toBeCloseTo(77.4, 1);
    expect(verdict.spareS).toBe(270 - JOG_S);
    expect(verdict.next).toBeNull();
  });

  it('dep 300 then 500 is NOT_WORTH_IT pointing at 500', () => {
    const verdict = verdictFor([300, 500]);
    expect(verdict.kind).toBe('NOT_WORTH_IT');
    expect(verdict.departure?.epoch).toBe(300);
    expect(verdict.next?.epoch).toBe(500);
    expect(verdict.spareS).toBeNull();
  });

  it('dep 150 then 900 is MISSED nesting CHILL for 900', () => {
    const verdict = verdictFor([150, 900]);
    expect(verdict.kind).toBe('MISSED');
    expect(verdict.departure?.epoch).toBe(150);
    expect(verdict.nested?.kind).toBe('CHILL');
    expect(verdict.nested?.departure?.epoch).toBe(900);
    expect(verdict.nested?.spareS).toBeCloseTo(484.8, 1);
    expect(verdict.spareS).toBeNull();
  });

  it('no departures is NO_SERVICE', () => {
    const verdict = verdictFor([]);
    expect(verdict.kind).toBe('NO_SERVICE');
    expect(verdict.departure).toBeNull();
    expect([verdict.next, verdict.nested, verdict.spareS, verdict.live]).toEqual([null, null, null, false]);
    expect(verdict.walkS).toBeCloseTo(385.2, 1);
  });

  it('stale live departure has low confidence', () => {
    const stale = hurryVerdict({ now: 0, walkMeters: 400, departures: [dep(600, true, true)] });
    expect([stale.kind, stale.live, stale.confidence]).toEqual(['CHILL', true, 'low']);
    const fresh = hurryVerdict({ now: 0, walkMeters: 400, departures: [dep(600, true, false)] });
    expect([fresh.live, fresh.confidence]).toEqual([true, 'normal']);
    const scheduled = verdictFor([600]);
    expect([scheduled.live, scheduled.confidence]).toEqual([false, 'normal']);
  });
});

describe('the hurry verdict: the card\'s edge rules (M7c.1)', () => {
  it('a gap of exactly worthItGapS is not worth a jog; one second more is', () => {
    expect(HURRY_DEFAULTS.worthItGapS).toBe(360);
    const at = verdictFor([300, 660]);
    expect([at.kind, at.next?.epoch]).toEqual(['NOT_WORTH_IT', 660]);
    expect(verdictFor([300, 661]).kind).toBe('JOG');
  });

  it('the last train is always worth a jog', () => {
    const verdict = verdictFor([300]);
    expect(verdict.kind).toBe('JOG');
    expect(verdict.spareS).toBeCloseTo(77.4, 1);
  });

  it('judges at most three departures and nests none when all three are missed', () => {
    expect(MAX_JUDGED).toBe(3);
    const verdict = verdictFor([100, 110, 120, 2000]);
    expect([verdict.kind, verdict.departure?.epoch, verdict.nested]).toEqual(['MISSED', 100, null]);
    expect(JSON.stringify(verdict)).not.toContain('2000');
  });

  it('nests the third departure when only it can be made, with the following train as its gap', () => {
    const verdict = verdictFor([100, 110, 300, 400]);
    expect(verdict.nested?.departure?.epoch).toBe(300);
    expect([verdict.nested?.kind, verdict.nested?.next?.epoch]).toEqual(['NOT_WORTH_IT', 400]);
    expect(verdictFor([100, 110, 300, 1000]).nested?.kind).toBe('JOG');
  });

  it('every setting overrides its default', () => {
    expect(verdictFor([600, 1200], { walkMps: 0.9 }).kind).toBe('JOG');
    expect(verdictFor([300, 1200], { jogMps: 1.5 }).kind).toBe('MISSED');
    const detour = verdictFor([450, 2000], { detour: 2 });
    expect([detour.kind, Math.round(detour.walkS * 10) / 10]).toEqual(['JOG', 592.6]);
    expect(verdictFor([400, 2000], { boardBufferS: 0 }).kind).toBe('CHILL');
    expect(verdictFor([300, 1200], { worthItGapS: 1000 }).kind).toBe('NOT_WORTH_IT');
  });

  it('refuses departures out of order and paces that make no sense', () => {
    expect(() => hurryVerdict({ now: 0, walkMeters: 400, departures: [dep(600), dep(300)] })).toThrow('sorted');
    expect(() => verdictFor([600], { jogMps: 1 })).toThrow('usable paces');
    expect(() => verdictFor([600], { walkMeters: -1 })).toThrow('non-negative');
  });
});
