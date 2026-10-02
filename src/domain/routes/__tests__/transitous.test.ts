import fixture from '../__fixtures__/transitous-plan.json';
import { buildPlanRequest, parseItineraries, type PlanQuery } from '../transitous';

/**
 * Plan M10a.1 A: the exact /api/v5/plan URL and User-Agent, and the parser over a REAL Government
 * Center → Brickell response (captured once with the app's User-Agent, 2026-10-02; walk geometry
 * stripped per the public-repo data rule — see the fixture's _provenance).
 */

const GOVERNMENT_CENTER = { latitude: 25.7745, longitude: -80.1953 };
const BRICKELL = { latitude: 25.7584, longitude: -80.1937 };
const QUERY: PlanQuery = { from: GOVERNMENT_CENTER, to: BRICKELL, timeEpoch: 1790881200, arriveBy: false };
const BODY: unknown = fixture;

type RawLeg = { readonly mode: string; readonly startTime: string };
type RawItinerary = { readonly legs: readonly RawLeg[] };
const RAW_ITINERARIES = (fixture as unknown as { itineraries: readonly RawItinerary[] }).itineraries;

describe('Transitous /plan request (M10a.1)', () => {
  it('request URL is exact', () => {
    expect(buildPlanRequest(QUERY, '1.0.0').url).toBe(
      'https://api.transitous.org/api/v5/plan?fromPlace=25.7745,-80.1953&toPlace=25.7584,-80.1937&time=2026-10-01T19:00:00.000Z&arriveBy=false',
    );
    const arriveBy = buildPlanRequest({ from: BRICKELL, to: { latitude: 25.797964, longitude: -80.25859 }, timeEpoch: 1791036900, arriveBy: true }, '1.0.0');
    expect(arriveBy.url).toBe(
      'https://api.transitous.org/api/v5/plan?fromPlace=25.7584,-80.1937&toPlace=25.797964,-80.25859&time=2026-10-03T14:15:00.000Z&arriveBy=true',
    );
  });

  it('User-Agent is exact', () => {
    for (const version of ['1.0.0', '2.3.4']) {
      const { headers } = buildPlanRequest(QUERY, version);
      expect(headers['User-Agent']).toBe(`MiamiTransit/${version} (+https://github.com/purpleperkel/miami-transit)`);
      // Transitous takes no key: the User-Agent is the only header.
      expect(Object.keys(headers)).toEqual(['User-Agent']);
    }
  });
});

describe('Transitous /plan parser (M10a.1)', () => {
  it('real fixture parses into >= 3 itineraries', () => {
    const parsed = parseItineraries(BODY);
    if (!parsed.ok) {
      throw new Error(`the real fixture did not parse: ${parsed.error.message}`);
    }
    const itineraries = parsed.value;
    expect(itineraries.length).toBeGreaterThanOrEqual(3);
    expect(itineraries.map((it) => it.legs.length)).toEqual(RAW_ITINERARIES.map((raw) => raw.legs.length));
    const legs = itineraries.flatMap((it) => it.legs);
    expect(legs.map((leg) => leg.mode)).toEqual(expect.arrayContaining(['WALK', 'TRAM', 'REGIONAL_RAIL']));
    const mover = legs.find((leg) => leg.mode === 'TRAM' && leg.routeShortName === 'MMO');
    const rail = legs.find((leg) => leg.mode === 'REGIONAL_RAIL' && leg.routeShortName === '2600');
    expect(mover?.tripId).toMatch(/^\d{8}_\d{1,2}:\d{2}_us-fl-miami-dade_\d+$/);
    expect(rail?.from.stopId).toMatch(/^us-fl-miami-dade_/);
    // Epoch seconds from startTime; a distance only where Transitous gives one (walk legs); nothing live yet.
    expect(legs[0]?.from.epoch).toBe(Date.parse(RAW_ITINERARIES[0]?.legs[0]?.startTime ?? '') / 1000);
    expect(legs.filter((leg) => leg.tripId !== null).every((leg) => leg.distanceM === null)).toBe(true);
    expect(legs.filter((leg) => leg.mode === 'WALK').every((leg) => leg.distanceM !== null && leg.tripId === null)).toBe(true);
    expect(legs.every((leg) => !leg.realTime && !leg.live)).toBe(true);
  });
});

describe('Transitous /plan parser on bad bodies (M10a.1)', () => {
  it('malformed body -> Err without throwing', () => {
    const good = (fixture as unknown as { itineraries: Record<string, unknown>[] }).itineraries[0] as Record<string, unknown>;
    const leg0 = (good.legs as Record<string, unknown>[])[0] as Record<string, unknown>;
    const bodies: readonly unknown[] = [
      null, 42, '<html>502 Bad Gateway</html>', {}, { itineraries: {} }, { itineraries: [{ ...good, legs: 'x' }] },
      { itineraries: [{ ...good, legs: [{ ...leg0, mode: 7 }] }] },
      { itineraries: [{ ...good, legs: [{ ...leg0, startTime: 'soon' }] }] },
      { itineraries: [{ ...good, legs: [{ ...leg0, from: undefined }] }] },
    ];
    for (const body of bodies) {
      const parsed = parseItineraries(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? null : parsed.error.kind).toBe('malformed');
    }
    expect(parseItineraries({ ...(fixture as object), itineraries: [] })).toEqual({ ok: true, value: [] });
  });
});
