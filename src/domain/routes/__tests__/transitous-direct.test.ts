import directOnly from '../__fixtures__/transitous-direct-only.json';
import fixture from '../__fixtures__/transitous-plan.json';
import { isWalkOnly, parseItineraries } from '../transitous';

/**
 * mfix7 (Jamie's 07:10 recording, "No route options" for an 8-minute walk near Brickell): when walking beats
 * every train, Transitous answers `itineraries: []` and puts the walk in `direct[]`. The committed body is the
 * arbiter's real 08:15 capture from the off-line point 25.7645,-80.1897 to Brickell City Centre (walk geometry
 * stripped per the public-repo data rule — see its _provenance).
 */

const CAPTURE_START_S = Date.parse('2026-10-02T12:15:00Z') / 1000;
const CAPTURE_END_S = Date.parse('2026-10-02T12:23:00Z') / 1000;

describe('Transitous direct (walk-only) answers (mfix7)', () => {
  it('a direct-only plan answer parses into a walk-only itinerary', () => {
    expect((directOnly as { itineraries: unknown[] }).itineraries).toHaveLength(0);
    const parsed = parseItineraries(directOnly as unknown);
    if (!parsed.ok) {
      throw new Error(`the direct-only capture did not parse: ${parsed.error.message}`);
    }
    expect(parsed.value).toHaveLength(1);
    const walk = parsed.value[0];
    expect(walk).toMatchObject({ startEpoch: CAPTURE_START_S, endEpoch: CAPTURE_END_S, durationS: 480, transfers: 0 });
    expect(walk === undefined ? false : isWalkOnly(walk)).toBe(true);
    expect(walk?.legs).toEqual([
      {
        mode: 'WALK',
        routeShortName: null,
        headsign: null,
        from: { name: 'START', stopId: null, epoch: CAPTURE_START_S, latitude: 25.7645, longitude: -80.1897 },
        to: { name: 'END', stopId: null, epoch: CAPTURE_END_S, latitude: 25.766888, longitude: -80.192121 },
        tripId: null,
        realTime: false,
        live: false,
        distanceM: 568,
        durationS: 480,
      },
    ]);
  });
});

describe('Transitous answers around the direct walks (mfix7)', () => {
  it('direct walks come after the transit itineraries, and an absent direct key reads as before', () => {
    const transit = parseItineraries(fixture as unknown);
    const mixed = parseItineraries({ ...(fixture as object), direct: (directOnly as { direct: unknown[] }).direct });
    const { direct: _dropped, ...absent } = fixture as Record<string, unknown>;
    expect(_dropped).toEqual([]);
    expect(transit.ok && transit.value.length).toBe(6);
    expect(mixed.ok ? mixed.value.map(isWalkOnly) : null).toEqual([false, false, false, false, false, false, true]);
    expect(mixed.ok ? mixed.value.slice(0, 6) : null).toEqual(transit.ok ? transit.value : 'unparsed');
    expect(parseItineraries(absent)).toEqual(transit);
    expect(parseItineraries({ ...(fixture as object), itineraries: [], direct: [] })).toEqual({ ok: true, value: [] });
  });

  it('a direct answer that is not a list of walks is malformed, never a throw', () => {
    const walk = (directOnly as { direct: Record<string, unknown>[] }).direct[0] as Record<string, unknown>;
    const leg = (walk.legs as Record<string, unknown>[])[0] as Record<string, unknown>;
    const bodies: readonly unknown[] = [
      { itineraries: [], direct: {} },
      { itineraries: [], direct: [{ ...walk, legs: [] }] },
      { itineraries: [], direct: [{ ...walk, legs: [{ ...leg, mode: 'BIKE' }] }] },
      { itineraries: [], direct: [{ ...walk, legs: [{ ...leg, startTime: 'soon' }] }] },
    ];
    for (const body of bodies) {
      const parsed = parseItineraries(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? null : parsed.error.message).toMatch(/direct/);
    }
  });
});
