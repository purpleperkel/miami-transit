import type { Mode } from '@/domain/network/stations';

import { COLOR_SCHEMES, lineColors, MAP_LAND } from '../../colors';
import { ZOOM_BUCKETS } from '../mapGeometry';
import { type StationVisualInput, stationVisual, visualKey } from '../vehicleVisual';

/**
 * M5.8 marker visuals: the visual key is what markers are keyed and memoised on, so it must change
 * whenever the look changes — selection and zoom bucket here; M5.9 adds a vehicle's own facets.
 */

const MODES: readonly Mode[] = ['rail', 'mover'];

/** Every combination of mode, zoom bucket and scheme, for one station key and selection. */
function everyLook(selected: boolean): StationVisualInput[] {
  const inputs = MODES.flatMap((mode) =>
    ZOOM_BUCKETS.flatMap((bucket) => COLOR_SCHEMES.map((scheme) => ({ stationKey: `${mode}:government-center`, mode, selected, bucket, scheme }))),
  );
  expect(inputs).toHaveLength(MODES.length * ZOOM_BUCKETS.length * COLOR_SCHEMES.length);
  expect(inputs.every((input) => input.selected === selected)).toBe(true);
  return inputs;
}

describe('station visuals (M5.8)', () => {
  it('visual key changes with selection', () => {
    for (const input of everyLook(false)) {
      const plain = stationVisual(input);
      const selected = stationVisual({ ...input, selected: true });
      expect(selected.key).not.toBe(plain.key);
      expect([selected.diameterPt > plain.diameterPt, selected.fill !== plain.fill]).toEqual([true, true]);
    }
  });

  it('visual key changes with zoom bucket', () => {
    for (const input of everyLook(true).filter((candidate) => candidate.bucket === 0)) {
      const looks = ZOOM_BUCKETS.map((bucket) => stationVisual({ ...input, bucket }));
      expect(new Set(looks.map((look) => look.key)).size).toBe(ZOOM_BUCKETS.length);
      const diameters = looks.map((look) => look.diameterPt);
      expect(diameters).toEqual([...diameters].sort((a, b) => a - b));
    }
  });

  it('the same look gives the same key, whatever order its facets are listed in', () => {
    expect(visualKey('station:rail:palmetto', { selected: false, bucket: 2, mode: 'rail' })).toBe(
      visualKey('station:rail:palmetto', { mode: 'rail', bucket: 2, selected: false }),
    );
    const input: StationVisualInput = { stationKey: 'rail:palmetto', mode: 'rail', selected: false, bucket: 2, scheme: 'light' };
    expect(stationVisual(input).key).toBe(stationVisual({ ...input }).key);
    expect(stationVisual(input).key).not.toBe(stationVisual({ ...input, scheme: 'dark' }).key);
  });

  it('a station is a land-coloured dot ringed in its system grey; selected, it fills', () => {
    for (const scheme of COLOR_SCHEMES) {
      const grey = lineColors('RAIL_TRUNK', scheme);
      const input: StationVisualInput = { stationKey: 'rail:palmetto', mode: 'rail', selected: false, bucket: 2, scheme };
      expect([stationVisual(input).fill, stationVisual(input).ring]).toEqual([MAP_LAND[scheme], grey.stroke]);
      expect([stationVisual({ ...input, selected: true }).fill, stationVisual({ ...input, selected: true }).ring]).toEqual([grey.stroke, grey.casing]);
    }
  });
});
