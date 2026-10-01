import { Stack } from 'expo-router';
import { Children, isValidElement, type ReactElement } from 'react';

import RootLayout from '../../../app/_layout';

/**
 * M8b.1 "The screen has a real title, never '(tabs)'": the root layout's options for the /data route,
 * read from the element tree RootLayout returns. The root Stack hides headers (the map is full-bleed),
 * so /data must show its own, and its back button must not read the tab group's route name "(tabs)"
 * (seen on the phone at M1.19).
 */

type ScreenProps = { readonly name?: string; readonly options?: Record<string, unknown>; readonly screenOptions?: Record<string, unknown>; readonly children?: unknown };

/** Every element in RootLayout's tree, walked with an explicit stack. */
function elementsOf(root: ReactElement): ReactElement<ScreenProps>[] {
  const out: ReactElement<ScreenProps>[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isValidElement<ScreenProps>(node)) {
      out.push(node);
      stack.push(...Children.toArray(node.props.children as never));
    }
  }
  expect(out[0]).toBe(root);
  expect(out.length).toBeGreaterThan(2);
  return out;
}

describe('the /data route header (M8b.1)', () => {
  it('the title is data & settings, never (tabs)', () => {
    const elements = elementsOf(RootLayout());
    const rootStack = elements.find((element) => element.type === Stack);
    const data = elements.filter((element) => element.type === Stack.Screen && element.props.name === 'data');
    expect(rootStack?.props.screenOptions?.headerShown).toBe(false);
    expect(data).toHaveLength(1);
    const options = data[0]?.props.options ?? {};
    expect(options.title).toBe('Data & Settings');
    expect(options.headerShown).toBe(true);
    expect(options.headerBackButtonDisplayMode).toBe('minimal');
    expect([options.title, options.headerBackTitle]).not.toContain('(tabs)');
  });
});
