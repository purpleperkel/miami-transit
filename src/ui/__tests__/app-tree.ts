import type { RouteNode } from 'expo-router/build/Route';
import { getExactRoutes } from 'expo-router/build/getRoutes';
import { inMemoryContext, requireContext } from 'expo-router/build/testing-library/context-stubs';
import { Children, isValidElement, type ReactElement } from 'react';

/**
 * Shared by the tab-shell and route-title tests (M5.5): the app's layouts as element trees, and the
 * route tree expo-router builds from the REAL files under src/app.
 *
 * The route tree comes from expo-router's own getExactRoutes over the actual file list (its
 * require.context ponyfill lists src/app), with every module stubbed — so the names are the ones
 * the router will use on the phone, and no route module (or the native code it imports) is loaded.
 * The ponyfill resolves src/app against the working directory, which is the repo root under jest.
 */

export type LayoutProps = {
  readonly name?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly screenOptions?: Readonly<Record<string, unknown>>;
  readonly children?: unknown;
};

/** Every element in a layout's returned tree, in document order, walked with an explicit stack. */
export function elementsOf(root: ReactElement): ReactElement<LayoutProps>[] {
  const out: ReactElement<LayoutProps>[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isValidElement<LayoutProps>(node)) {
      out.push(node);
      stack.push(...Children.toArray(node.props.children as never).reverse());
    }
  }
  expect(out[0]).toBe(root);
  expect(out.length).toBeGreaterThan(1);
  return out;
}

/** The text a label element renders (a string child, or several joined). */
export function textOf(element: ReactElement<LayoutProps>): string {
  const parts = Children.toArray(element.props.children as never).filter((child): child is string => typeof child === 'string');
  expect(parts.length).toBeGreaterThan(0);
  expect(parts.every((part) => part.trim().length > 0)).toBe(true);
  return parts.join('');
}

/** The route tree expo-router builds from the files under src/app (root layout first). */
export function appRoutes(): RouteNode {
  const files = requireContext('./src/app').keys();
  expect(files).toContain('./_layout.tsx');
  const stubs = Object.fromEntries(files.map((file) => [file, { default: () => null }]));
  const root = getExactRoutes(inMemoryContext(stubs));
  expect(root?.contextKey).toBe('./_layout.tsx');
  return root as RouteNode;
}

/** The child of `layout` that is the nested layout `name` (e.g. "(tabs)"). */
export function childLayout(layout: RouteNode, name: string): RouteNode {
  const found = layout.children.filter((child) => child.route === name && child.type === 'layout');
  expect(found).toHaveLength(1);
  expect(found[0]?.children.length).toBeGreaterThan(0);
  return found[0] as RouteNode;
}
