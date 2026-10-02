import { router } from 'expo-router';

import TripsRoute from '@/app/(tabs)/trips/index';

import { appRoutes } from '../../__tests__/app-tree';
import { MapControlStack } from '../../map/MapControlStack';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { PLAN_PATH } from '../../sheets';
import { StationSheetFooter } from '../../stations/StationSheetFooter';
import { press } from '../../stations/__tests__/press';

// test-time mock of native module
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView', isLiquidGlassAvailable: () => true }));

/**
 * Plan M10b.1 entry points: the route options sheet opens from the map's Directions button, from the
 * station sheet's "Route from here" (starting at that station), and — ruling R6 — from the Trips tab's
 * empty state, "Plan a route". Navigation is observed by spying on expo-router's router.push, and the
 * route pushed is checked against the app's real route files.
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});

/** A spy on router.push that navigates nowhere. */
function spyPush(): jest.SpyInstance {
  const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
  expect(push).not.toHaveBeenCalled();
  expect(appRoutes().children.map((child) => `/${child.route}`)).toContain(PLAN_PATH);
  return push;
}

describe('the Trips tab before saved trips (M10b, ruling R6)', () => {
  it('Trips tab empty state offers Plan a route linking /plan', async () => {
    const push = spyPush();
    const tree = await renderPrimitive(<TripsRoute />);
    const button = hostsByTestID(tree.root, 'trips-plan-route');
    expect(button[0]?.props.accessibilityLabel).toBe('Plan a route');
    expect(JSON.stringify(tree.toJSON())).toContain('"No trips yet"');
    await press(tree, 'trips-plan-route');
    expect(push.mock.calls).toEqual([['/plan']]);
  });
});

describe('the doors to the route options sheet (M10b.1)', () => {
  it('the map Directions button opens the sheet from where the rider is', async () => {
    const push = spyPush();
    const tree = await renderPrimitive(<MapControlStack />);
    expect(hostsByTestID(tree.root, 'map-control-directions')[0]?.props.accessibilityLabel).toBe('Directions');
    await press(tree, 'map-control-directions');
    expect(push.mock.calls).toEqual([['/plan']]);
  });

  it('the station sheet Route from here opens the sheet starting at that station', async () => {
    const push = spyPush();
    const tree = await renderPrimitive(<StationSheetFooter stationKey="rail:brickell" coordinate={{ latitude: 25.7638, longitude: -80.1955 }} />);
    expect(hostsByTestID(tree.root, 'station-route-from-here')[0]?.props.accessibilityLabel).toBe('Route from here');
    await press(tree, 'station-route-from-here');
    expect(push.mock.calls).toEqual([[{ pathname: '/plan', params: { fromStation: 'rail:brickell' } }]]);
  });
});
