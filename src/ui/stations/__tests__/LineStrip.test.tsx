import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { LineStrip } from '../LineStrip';

/** M6.5: the station's line strip — one segment per line, never colour alone (§4). */

afterEach(async () => {
  await unmountAll();
});

describe('LineStrip (M6.5)', () => {
  it('LineStrip accessibility label names every line', async () => {
    const trunk = await renderPrimitive(<LineStrip lines={['GREEN', 'ORANGE']} />);
    expect(hostsByTestID(trunk.root, 'line-strip')[0]?.props.accessibilityLabel).toBe('Green Line and Orange Line');
    const mover = await renderPrimitive(<LineStrip lines={['MM_INNER', 'MM_OMNI', 'MM_BRICKELL']} testID="mover-strip" />);
    expect(hostsByTestID(mover.root, 'mover-strip')[0]?.props.accessibilityLabel).toBe('Inner Loop, Omni and Brickell');
    const airport = await renderPrimitive(<LineStrip lines={['ORANGE']} testID="airport-strip" />);
    expect(hostsByTestID(airport.root, 'airport-strip')[0]?.props.accessibilityLabel).toBe('Orange Line');
  });

  it('draws one named segment per line, in the order given', async () => {
    const tree = await renderPrimitive(<LineStrip lines={['GREEN', 'ORANGE']} />);
    const segments = hostsByTestID(tree.root, /^line-strip-segment-/);
    expect(segments.map((segment) => segment.props.testID)).toEqual(['line-strip-segment-GREEN', 'line-strip-segment-ORANGE']);
    expect(segments.map((segment) => segment.props.accessibilityLabel)).toEqual(['Green Line', 'Orange Line']);
  });

  it('a strip with no line is a broken contract', async () => {
    await expect(renderPrimitive(<LineStrip lines={[]} />)).rejects.toThrow('at least one line');
    await expect(renderPrimitive(<LineStrip lines={['GREEN', 'GREEN']} />)).rejects.toThrow('each line is one segment');
  });
});
