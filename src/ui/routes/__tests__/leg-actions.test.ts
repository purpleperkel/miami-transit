import { legTarget, openDirections, openLink, transitDirectionsUrl, walkDirectionsUrl } from '../leg-actions';
import { searchPlace } from '../place-search';
import { geocodeQuery } from '../route-options';
import { fixtureLeg } from './route-fixtures';

/**
 * Plan M10b.2: the itinerary's links, on their own. Every Apple Maps link is m6b's builder's
 * (src/domain/handoff/apple-maps.ts, ruling R5), and openURL's resolved value is never read (M1.19).
 */

describe('directions links (M10b.2)', () => {
  it('builds walking and transit links with the one Apple Maps builder', () => {
    expect(walkDirectionsUrl({ lat: 25.7759, lon: -80.1961 })).toBe('maps://?daddr=25.7759,-80.1961&dirflg=w');
    expect(transitDirectionsUrl({ lat: 25.7759, lon: -80.1961 })).toBe('maps://?daddr=25.7759,-80.1961&dirflg=r');
    // A walk leads to its leg's end: the Mover leg's alighting station, Financial District.
    expect(walkDirectionsUrl(legTarget(fixtureLeg('MMO')))).toBe('maps://?daddr=25.760382,-80.19288&dirflg=w');
  });

  it('opening resolves ok on any resolution, and falls back to the web host once', async () => {
    for (const value of [undefined, false, true, null]) {
      const calls: string[] = [];
      const opened = await openDirections('maps://?daddr=25.7759,-80.1961&dirflg=r', async (url) => {
        calls.push(url);
        return value;
      });
      expect([opened.ok, calls]).toEqual([true, ['maps://?daddr=25.7759,-80.1961&dirflg=r']]);
    }
    const calls: string[] = [];
    const fellBack = await openDirections('maps://?daddr=25.7759,-80.1961&dirflg=w', async (url) => {
      calls.push(url);
      return url.startsWith('maps://') ? Promise.reject(new Error('no maps://')) : undefined;
    });
    expect(fellBack).toEqual({ ok: true, value: { url: 'https://maps.apple.com/?daddr=25.7759,-80.1961&dirflg=w', fellBack: true } });
    expect(calls).toHaveLength(2);
  });

  it('refuses a link the app does not build, without opening anything', async () => {
    const openURL = jest.fn(async (_url: string): Promise<void> => undefined);
    for (const url of ['maps://?daddr=25.77590,-80.1961&dirflg=w', 'maps://?daddr=95,-80&dirflg=w', 'https://example.com']) {
      const refused = await openDirections(url, openURL);
      expect(refused.ok ? null : refused.error.link).toBe(url);
    }
    expect(openURL).not.toHaveBeenCalled();
  });

  it('a web page that will not open is an err naming it', async () => {
    const refused = await openLink('https://transitous.org/sources', async () => Promise.reject(new Error('Safari is restricted')));
    expect(refused).toEqual({ ok: false, error: { kind: 'link-failed', link: 'https://transitous.org/sources', message: 'Safari is restricted' } });
    const opened = await openLink('https://transitous.org/sources', async () => false);
    expect(opened.ok).toBe(true);
  });
});

describe('searching for a destination (M10b.1)', () => {
  it('geocodes the words in Miami-Dade and names the place by them', async () => {
    const asked: string[] = [];
    const found = await searchPlace('  Brickell City Centre ', async (address) => {
      asked.push(address);
      return [{ latitude: 25.7671, longitude: -80.1931 }];
    });
    expect(asked).toEqual(['Brickell City Centre, Miami-Dade County, FL']);
    expect(found).toEqual({ ok: true, value: { name: 'Brickell City Centre', lat: 25.7671, lon: -80.1931 } });
    expect(geocodeQuery('1 SE 3rd Ave, Miami, FL 33131')).toBe('1 SE 3rd Ave, Miami, FL 33131');
  });

  it('says when nothing matches, or the geocoder fails', async () => {
    expect(await searchPlace('Atlantis', async () => [])).toEqual({ ok: false, error: 'No place found for “Atlantis”' });
    expect(await searchPlace('Brickell', async () => Promise.reject(new Error('rate limited')))).toEqual({ ok: false, error: 'The search did not work: rate limited' });
  });
});
