import { router } from 'expo-router';
import { act } from 'react-test-renderer';

import { DATA_STATUS_PRIORITY, type DataStatus, statusFace } from '../../dataStatus';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { DATA_SETTINGS_ROUTE, StatusPill } from '../StatusPill';
import { appRoutes } from '../../__tests__/app-tree';

// test-time mock of native module
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView', isLiquidGlassAvailable: () => true }));

/**
 * M5.11 the status pill, on Liquid Glass (expo-glass-effect is
 * native, so it is mocked as available). Navigation is observed by spying on expo-router's
 * router.push; the routes pushed are checked against the app's real route files.
 */

/** One example of every status, in priority order. */
const EVERY_STATUS: readonly DataStatus[] = [
  { kind: 'expired' },
  { kind: 'offline' },
  { kind: 'stale', ageS: 130 },
  { kind: 'live' },
  { kind: 'expiring', daysLeft: 9 },
  { kind: 'scheduled' },
];

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});

/** The routes expo-router builds from src/app, as absolute paths. */
function routePaths(): string[] {
  const paths = appRoutes().children.map((child) => `/${child.route}`);
  expect(paths.length).toBeGreaterThan(2);
  expect(paths).toContain('/data');
  return paths;
}

describe('StatusPill (M5.11)', () => {
  it('icon and word for every status', async () => {
    expect(EVERY_STATUS.map((status) => status.kind)).toEqual([...DATA_STATUS_PRIORITY]);
    for (const status of EVERY_STATUS) {
      const tree = await renderPrimitive(<StatusPill status={status} reduceMotion={false} />);
      const icon = tree.root.findByProps({ testID: 'status-pill-icon' });
      const word = tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'status-pill-text');
      expect([status.kind, icon.props.name]).toEqual([status.kind, statusFace(status).icon]);
      expect(String(icon.props.name).length).toBeGreaterThan(0);
      expect(word).toHaveLength(1);
      expect(word[0]?.props.children).toBe(statusFace(status).text);
      expect(tree.root.findByProps({ testID: 'status-pill' }).props.accessibilityLabel).toContain(statusFace(status).text);
    }
  });

  it('the live radio waves pulse, except under Reduce Motion', async () => {
    const moving = await renderPrimitive(<StatusPill status={{ kind: 'live' }} reduceMotion={false} />);
    expect(moving.root.findByProps({ testID: 'status-pill-icon' }).props.animationSpec).toMatchObject({ repeating: true });
    const still = await renderPrimitive(<StatusPill status={{ kind: 'live' }} reduceMotion />);
    expect(still.root.findByProps({ testID: 'status-pill-icon' }).props.animationSpec).toBeUndefined();
  });

  it('a tap opens Data & Settings', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const tree = await renderPrimitive(<StatusPill status={{ kind: 'scheduled' }} reduceMotion={false} />);
    await act(async () => {
      tree.root.findByProps({ testID: 'status-pill' }).props.onPress();
    });
    expect(push).toHaveBeenCalledWith(DATA_SETTINGS_ROUTE);
    expect(routePaths()).toContain(DATA_SETTINGS_ROUTE);
  });
});
