import * as dataProbes from '../data-probes';
import * as deviceProbes from '../device-probes';
import { PROBES } from '../probe-catalog';

describe('PROBES (the Diagnostics screen catalog)', () => {
  it('lists every exported probe exactly once', () => {
    const exported = [...Object.entries(dataProbes), ...Object.entries(deviceProbes)]
      .filter(([name]) => name.startsWith('probe'))
      .map(([, probe]) => probe);
    expect(exported).toHaveLength(9);
    expect(PROBES.map((spec) => spec.run)).toEqual(expect.arrayContaining(exported));
    expect(new Set(PROBES.map((spec) => spec.id)).size).toBe(PROBES.length);
    expect(PROBES).toHaveLength(9);
  });

  it('keeps only the app-leaving maps:// probe out of "Run all"', () => {
    const leaving = PROBES.filter((spec) => spec.leavesApp).map((spec) => spec.id);
    expect(leaving).toEqual(['maps']);
    expect(PROBES.find((spec) => spec.id === 'maps')?.run).toBe(deviceProbes.probeMapsLink);
  });
});
