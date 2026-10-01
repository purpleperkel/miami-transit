import { router } from 'expo-router';
import { act } from 'react-test-renderer';

import { appRoutes } from '../../__tests__/app-tree';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { LAYERS_ROUTE, MapControlStack } from '../MapControlStack';
import { MIN_HIT_AREA_PT } from '../vehicleVisual';

// test-time mock of native module
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView', isLiquidGlassAvailable: () => true }));

/**
 * M5.11 the map's control stack, on Liquid Glass (expo-glass-effect is native, so it is mocked as
 * available). Its Layers button is the door to the Layers sheet; navigation is observed by spying on
 * expo-router's router.push, and the route pushed is checked against the app's real route files.
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});

describe('MapControlStack (M5.11)', () => {
  it('layers button opens the layers sheet', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const tree = await renderPrimitive(<MapControlStack />);
    const button = tree.root.findByProps({ testID: 'map-control-layers' });
    expect([button.props.accessibilityLabel, button.props.accessibilityRole]).toEqual(['Layers', 'button']);
    await act(async () => {
      button.props.onPress();
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(LAYERS_ROUTE);
    expect(LAYERS_ROUTE).toBe('/layers');
    expect(appRoutes().children.map((child) => `/${child.route}`)).toContain(LAYERS_ROUTE);
  });

  it('each control is a 44 pt square', async () => {
    const tree = await renderPrimitive(<MapControlStack />);
    const buttons = tree.root.findAll((node) => typeof node.type === 'string' && String(node.props.testID).startsWith('map-control-'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.props.style?.width >= MIN_HIT_AREA_PT && button.props.style?.height >= MIN_HIT_AREA_PT)).toBe(true);
  });
});
