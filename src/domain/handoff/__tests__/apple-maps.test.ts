import { appleMapsUrl, openAppleMaps, type OpenUrl } from '../apple-maps';

/**
 * M7.6 (R5): the Apple Maps handoff — the plan's exact URLs, and the M1.19 handoff rule: React
 * Native's Linking.openURL is Promise<void>, so a resolution of ANY value is "opened" and only a
 * rejection is a failure (then the https://maps.apple.com URL is tried).
 */

const GOVERNMENT_CENTER = { latitude: 25.7759, longitude: -80.1961 };

/** An opener that answers each URL as `answer` says, recording every URL it was asked to open. */
function opener(answer: (url: string) => Promise<unknown>): { open: OpenUrl; urls: string[] } {
  const urls: string[] = [];
  const open: OpenUrl = (url) => {
    expect(url).toMatch(/^(maps:\/\/\?|https:\/\/maps\.apple\.com\/\?)daddr=/);
    urls.push(url);
    expect(urls.length).toBeLessThanOrEqual(2);
    return answer(url);
  };
  expect(urls).toHaveLength(0);
  expect(typeof open).toBe('function');
  return { open, urls };
}

describe('Apple Maps URLs (M7.6)', () => {
  it('transit url is the Maps app with dirflg=r to the destination', () => {
    expect(appleMapsUrl(GOVERNMENT_CENTER, 'transit')).toBe('maps://?daddr=25.7759,-80.1961&dirflg=r');
    expect(appleMapsUrl({ latitude: 25.77593412, longitude: -80.19611 }, 'transit')).toBe('maps://?daddr=25.775934,-80.19611&dirflg=r');
  });

  it('walk url asks for walking directions', () => {
    expect(appleMapsUrl(GOVERNMENT_CENTER, 'walk')).toBe('maps://?daddr=25.7759,-80.1961&dirflg=w');
    expect(appleMapsUrl(GOVERNMENT_CENTER, 'walk')).toContain('dirflg=w');
  });

  it('fallback url is the same directions on https://maps.apple.com', () => {
    expect(appleMapsUrl(GOVERNMENT_CENTER, 'transit', 'web')).toBe('https://maps.apple.com/?daddr=25.7759,-80.1961&dirflg=r');
    expect(appleMapsUrl(GOVERNMENT_CENTER, 'walk', 'web')).toBe('https://maps.apple.com/?daddr=25.7759,-80.1961&dirflg=w');
  });

  it('a destination off the globe is refused', () => {
    expect(() => appleMapsUrl({ latitude: 125, longitude: -80 }, 'walk')).toThrow('real destination');
    expect(() => appleMapsUrl({ latitude: Number.NaN, longitude: -80 }, 'walk')).toThrow('real destination');
  });
});

describe('the handoff rule (M1.19): resolved = opened, rejected = try the web host', () => {
  it('openURL resolving undefined counts as opened, so the web host is never tried', async () => {
    const { open, urls } = opener(() => Promise.resolve(undefined));
    const opened = await openAppleMaps(GOVERNMENT_CENTER, 'transit', open);
    expect(opened).toEqual({ ok: true, value: { url: 'maps://?daddr=25.7759,-80.1961&dirflg=r', fellBack: false } });
    expect(urls).toEqual(['maps://?daddr=25.7759,-80.1961&dirflg=r']);
  });

  it('openURL resolving false is still opened: the resolved value is never read', async () => {
    const { open, urls } = opener(() => Promise.resolve(false));
    const opened = await openAppleMaps(GOVERNMENT_CENTER, 'walk', open);
    expect(opened).toEqual({ ok: true, value: { url: 'maps://?daddr=25.7759,-80.1961&dirflg=w', fellBack: false } });
    expect(urls).toHaveLength(1);
  });

  it('openURL rejects falls back to the https web host', async () => {
    const { open, urls } = opener((url) => (url.startsWith('maps://') ? Promise.reject(new Error('no app for maps://')) : Promise.resolve(undefined)));
    const opened = await openAppleMaps(GOVERNMENT_CENTER, 'transit', open);
    expect(opened).toEqual({ ok: true, value: { url: 'https://maps.apple.com/?daddr=25.7759,-80.1961&dirflg=r', fellBack: true } });
    expect(urls).toEqual(['maps://?daddr=25.7759,-80.1961&dirflg=r', 'https://maps.apple.com/?daddr=25.7759,-80.1961&dirflg=r']);
  });

  it('both refused is an Err naming both URLs and the last reason', async () => {
    const { open, urls } = opener(() => Promise.reject(new Error('Safari is restricted')));
    const opened = await openAppleMaps(GOVERNMENT_CENTER, 'walk', open);
    expect(opened.ok).toBe(false);
    expect(opened.ok ? null : opened.error).toEqual({ kind: 'handoff-failed', urls, message: 'Safari is restricted' });
    expect(urls).toHaveLength(2);
  });
});
