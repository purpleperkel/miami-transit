import type { ReactTestRenderer } from 'react-test-renderer';

import { recordTickTime, tickTimeReadout } from '../../map/tickTime';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { DiagnosticsScreen, mapTickText } from '../DiagnosticsScreen';

/**
 * M5.13 "Diagnostics tick time < 4 ms": the REAL Diagnostics screen shows the map's frame-tick time,
 * read from the recorder useVehicleFrames feeds (tickTime.ts). The ticks below are recorded through
 * that same recorder, so the ms on screen are the recorded ones.
 */

afterEach(async () => {
  await unmountAll();
});

/** Every string rendered under the host node with testID "map-tick", joined. */
function mapTickRow(tree: ReactTestRenderer): string {
  const rows = tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'map-tick');
  expect(rows).toHaveLength(1);
  const texts = rows[0]?.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string') ?? [];
  expect(texts.length).toBeGreaterThan(0);
  return texts.map((node) => node.props.children as string).join(' | ');
}

describe('the Diagnostics tick-time readout (M5.13)', () => {
  it('diagnostics shows the map tick time in ms', async () => {
    const before = tickTimeReadout()?.count ?? 0;
    recordTickTime(3.14);
    recordTickTime(1.78);
    const tree = await renderPrimitive(<DiagnosticsScreen />);
    const row = mapTickRow(tree);
    expect(row).toContain(`Map tick 1.8 ms (last) · 3.1 ms (max) · ${before + 2} ticks`);
    expect(row).toContain('under 4 ms');
  });

  it('the readout says when no map frame was drawn yet, and counts ticks in words', () => {
    expect(mapTickText(null)).toBe('No map ticks yet');
    expect(mapTickText({ lastMs: 0.04, maxMs: 2, count: 1 })).toBe('Map tick 0.0 ms (last) · 2.0 ms (max) · 1 tick');
    expect(mapTickText({ lastMs: 3.96, maxMs: 12.25, count: 412 })).toBe('Map tick 4.0 ms (last) · 12.3 ms (max) · 412 ticks');
  });
});
