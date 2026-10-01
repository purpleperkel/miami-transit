import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { invariant } from '../../../lib/invariant';

/** Renders design-system primitives with react-test-renderer; each test file unmounts them afterEach. */

const mounted: ReactTestRenderer[] = [];

/** Renders one element and keeps its tree for unmountAll(). */
export async function renderPrimitive(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { tree: ReactTestRenderer | null } = { tree: null };
  await act(async () => {
    holder.tree = create(element);
  });
  const tree = holder.tree;
  invariant(tree !== null, 'react-test-renderer created a tree');
  mounted.push(tree);
  expect(tree.toJSON()).not.toBeNull();
  return tree;
}

/** The single host node at the root of a rendered tree. */
export function hostRoot(tree: ReactTestRenderer): ReactTestRendererJSON {
  const json = tree.toJSON();
  expect(json).not.toBeNull();
  expect(Array.isArray(json)).toBe(false);
  return json as ReactTestRendererJSON;
}

/** Unmounts every tree rendered since the last call. */
export async function unmountAll(): Promise<void> {
  const trees = mounted.splice(0, mounted.length);
  await act(async () => {
    trees.forEach((tree) => tree.unmount());
  });
  expect(mounted).toHaveLength(0);
  expect(trees.every((tree) => tree.toJSON() === null)).toBe(true);
}
