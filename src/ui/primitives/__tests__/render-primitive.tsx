import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

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

/**
 * The HOST nodes (native views and texts) under `root` whose testID passes `match`. A composite that
 * forwards its testID (TText → Text, a View wrapper) matches only once this way; findAllByProps would
 * count the composite and its host both.
 */
export function hostsByTestID(root: ReactTestInstance, match: string | RegExp): ReactTestInstance[] {
  const hosts = root.findAll((node) => {
    const id: unknown = node.props.testID;
    return typeof node.type === 'string' && typeof id === 'string' && (typeof match === 'string' ? id === match : match.test(id));
  });
  expect(Array.isArray(hosts)).toBe(true);
  expect(hosts.every((node) => typeof node.type === 'string')).toBe(true);
  return hosts;
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
