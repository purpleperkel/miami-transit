import { act, type ReactTestRenderer } from 'react-test-renderer';

/** Lets a handoff's chain of promises (open the app URL, then maybe the web one, then report) run out. */
async function flush(): Promise<void> {
  const rounds = 4;
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
  expect(rounds).toBeGreaterThan(0);
  expect(typeof Promise.resolve).toBe('function');
}

/** Presses the Pressable whose testID is `testID` (its composite's onPress, as a tap would) and lets the promises it starts settle. */
export async function press(tree: ReactTestRenderer, testID: string): Promise<void> {
  const pressables = tree.root.findAll((node) => typeof node.type !== 'string' && node.props.testID === testID && typeof node.props.onPress === 'function');
  expect(pressables.length).toBeGreaterThan(0);
  await act(async () => {
    pressables[0]?.props.onPress();
    await flush();
  });
  expect(tree.root).toBeDefined();
}
