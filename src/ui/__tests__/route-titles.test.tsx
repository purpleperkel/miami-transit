import type { RouteNode } from 'expo-router/build/Route';
import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

import RootLayout from '@/app/_layout';

import { appRoutes, elementsOf, type LayoutProps } from './app-tree';

/**
 * M5.5 (fixing the M1.19 phone finding: Diagnostics' back button read "(tabs)"). The root Stack hides
 * headers, because the map is full-bleed; every route pushed onto it must show a header with a real
 * title, and its back button must never read a route or group name. The pushed routes are the ones
 * expo-router builds from the real files under src/app, so a new route without options fails here.
 */

type Options = Readonly<Record<string, unknown>>;

/** Every route and group name in the app ("(tabs)", "data", "trips/index", …). */
function routeNames(root: RouteNode): Set<string> {
  const names = new Set<string>();
  const stack: RouteNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as RouteNode;
    names.add(node.route);
    stack.push(...node.children);
  }
  expect(names.has('(tabs)')).toBe(true);
  expect(names.size).toBeGreaterThan(3);
  return names;
}

/** A label a person reads: words, not a route name, a group "(name)" or a path. */
function isRealLabel(value: unknown, names: ReadonlySet<string>): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  expect(names.size).toBeGreaterThan(0);
  expect(typeof text).toBe('string');
  return text.length > 0 && !names.has(text) && !/^\(.*\)$/.test(text) && !/[/[\]]/.test(text);
}

/** The root Stack's own options and each screen's, read from the element tree RootLayout returns. */
function rootStack(): { readonly defaults: Options; readonly screens: readonly ReactElement<LayoutProps>[] } {
  const elements = elementsOf(RootLayout());
  const stacks = elements.filter((element) => element.type === Stack);
  expect(stacks).toHaveLength(1);
  const screens = elements.filter((element) => element.type === Stack.Screen);
  expect(screens.length).toBeGreaterThan(1);
  return { defaults: stacks[0]?.props.screenOptions ?? {}, screens };
}

/** The routes pushed onto the root Stack: its child ROUTES (the tab group is a layout, shown under them). */
function pushedRoutes(root: RouteNode): string[] {
  const pushed = root.children.filter((child) => child.type === 'route').map((child) => child.route);
  expect(pushed).toEqual(expect.arrayContaining(['data', 'diagnostics']));
  expect(pushed).not.toContain('(tabs)');
  return pushed;
}

/** The options the root layout gives one pushed route; it must declare that route exactly once. */
function optionsOf(screens: readonly ReactElement<LayoutProps>[], route: string): Options {
  const declared = screens.filter((screen) => screen.props.name === route);
  expect(declared).toHaveLength(1);
  expect(declared[0]?.props.options).toBeDefined();
  return declared[0]?.props.options ?? {};
}

describe('the root stack (M1.19, M5.5)', () => {
  it('every pushed route has a title', () => {
    const routes = appRoutes();
    const names = routeNames(routes);
    const { screens } = rootStack();
    for (const route of pushedRoutes(routes)) {
      const options = optionsOf(screens, route);
      expect([route, options.headerShown]).toEqual([route, true]);
      expect([route, options.title, isRealLabel(options.title, names)]).toEqual([route, options.title, true]);
    }
  });

  it('no back button reads (tabs)', () => {
    const routes = appRoutes();
    const names = routeNames(routes);
    const { defaults, screens } = rootStack();
    expect(defaults.headerShown).toBe(false);
    expect(isRealLabel(defaults.headerBackTitle, names)).toBe(true);
    for (const route of pushedRoutes(routes)) {
      const options = optionsOf(screens, route);
      const back = options.headerBackTitle ?? defaults.headerBackTitle;
      const chevronOnly = options.headerBackButtonDisplayMode === 'minimal';
      expect([route, back, chevronOnly || isRealLabel(back, names)]).toEqual([route, back, true]);
      expect(back).not.toBe('(tabs)');
    }
  });
});

describe('the Layers sheet (M5.12)', () => {
  it('the layers route opens as a formSheet titled Layers', () => {
    const routes = appRoutes();
    expect(pushedRoutes(routes)).toContain('layers');
    const options = optionsOf(rootStack().screens, 'layers');
    expect([options.presentation, options.title, options.headerShown]).toEqual(['formSheet', 'Layers', true]);
    expect(options.sheetAllowedDetents).toEqual([0.5, 1]);
    expect(isRealLabel(options.title, routeNames(routes))).toBe(true);
  });
});

describe('the station and vehicle sheets (M6.4, M6.6)', () => {
  it('both open as native formSheets that leave the map usable at their smallest height', () => {
    const routes = appRoutes();
    const screens = rootStack().screens;
    expect(pushedRoutes(routes)).toEqual(expect.arrayContaining(['station/[stationKey]', 'vehicle/[vehicleKey]']));
    for (const [route, title] of [['station/[stationKey]', 'Station'], ['vehicle/[vehicleKey]', 'Vehicle']] as const) {
      const options = optionsOf(screens, route);
      expect([route, options.presentation, options.title, options.headerShown]).toEqual([route, 'formSheet', title, true]);
      expect([route, options.sheetLargestUndimmedDetentIndex, (options.sheetAllowedDetents as number[]).length]).toEqual([route, 0, 2]);
    }
  });
});
