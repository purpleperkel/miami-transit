import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { PlatformColor, StyleSheet, Text } from 'react-native';

import { Glass } from '../Glass';
import { hostRoot, renderPrimitive, unmountAll } from './render-primitive';

// test-time mock of native module
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView', isLiquidGlassAvailable: jest.fn() }));

/**
 * M5.4 Glass: Liquid Glass where iOS has it, a solid surface where it does not. expo-glass-effect is
 * native (GlassView is a UIKit view, isLiquidGlassAvailable reads the native module), so it is mocked:
 * GlassView as a host element of that name, isLiquidGlassAvailable as the switch under test.
 */

const mockAvailable = jest.mocked(isLiquidGlassAvailable);

afterEach(async () => {
  mockAvailable.mockReset();
  await unmountAll();
});

describe('Glass', () => {
  it('falls back to solid when isLiquidGlassAvailable() is false', async () => {
    mockAvailable.mockReturnValue(false);
    const tree = await renderPrimitive(
      <Glass testID="now-strip">
        <Text>Leave in 6 min</Text>
      </Glass>,
    );
    const root = hostRoot(tree);
    expect(JSON.stringify(root)).not.toContain('"GlassView"');
    expect([root.type, root.props.testID]).toEqual(['View', 'now-strip']);
    expect(StyleSheet.flatten(root.props.style).backgroundColor).toEqual(PlatformColor('systemBackground'));
    expect(JSON.stringify(root)).toContain('"Leave in 6 min"');
    expect(mockAvailable).toHaveBeenCalled();
  });

  it('renders GlassView when isLiquidGlassAvailable() is true', async () => {
    mockAvailable.mockReturnValue(true);
    const tree = await renderPrimitive(
      <Glass testID="now-strip">
        <Text>Leave in 6 min</Text>
      </Glass>,
    );
    const root = hostRoot(tree);
    expect([root.type, root.props.testID, root.props.glassEffectStyle]).toEqual(['GlassView', 'now-strip', 'regular']);
    expect(StyleSheet.flatten(root.props.style).backgroundColor).toBeUndefined();
    expect(JSON.stringify(root)).toContain('"Leave in 6 min"');
    expect(mockAvailable).toHaveBeenCalled();
  });
});
