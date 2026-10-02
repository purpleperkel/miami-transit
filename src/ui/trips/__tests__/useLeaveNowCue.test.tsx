import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Text } from 'react-native';
import { act } from 'react-test-renderer';

import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import type { CountdownState } from '../countdown';
import { cueLeaveNow, departureKey, shouldCue, useLeaveNowCue } from '../useLeaveNowCue';

// test-time mock of native module
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(() => Promise.resolve()), NotificationFeedbackType: { Success: 'success' } }));

/**
 * M7.5: "Leave now" is felt and heard ONCE per departure — one Success haptic (expo-haptics, the labelled
 * test-time mock) and one VoiceOver announcement (React Native's AccessibilityInfo, spied on) — however
 * often the countdown re-renders; the next departure reaching "now" cues again. Each test keeps its own
 * memory of cued departures (a fresh Set), so the module-wide one is never shared between tests.
 */

const TICKS: readonly CountdownState[] = ['normal', 'soon', 'soon', 'now', 'now', 'now', 'missed'];

afterEach(async () => {
  jest.restoreAllMocks();
  jest.mocked(Haptics.notificationAsync).mockClear();
  await unmountAll();
});

/** Runs a countdown's ticks for one departure through cueLeaveNow; how many times it cued. */
function runTicks(key: string, cued: Set<string>): number {
  const fired = TICKS.filter((state) => cueLeaveNow(state, key, 'Leave now for Home: the 8:14 train.', () => undefined, cued)).length;
  expect(cued.has(key)).toBe(true);
  expect(fired).toBeLessThanOrEqual(1);
  return fired;
}

describe('the leave-now cue (M7.5)', () => {
  it('shouldCue fires once per departure', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    const cued = new Set<string>();
    const key = departureKey('home', 1_790_770_440);
    expect(shouldCue('soon', key, cued)).toBe(false);
    expect(shouldCue('now', key, cued)).toBe(true);
    expect(runTicks(key, cued)).toBe(1);
    expect(shouldCue('now', key, cued)).toBe(false);
    expect(jest.mocked(Haptics.notificationAsync).mock.calls).toEqual([['success']]);
    expect(announce.mock.calls).toEqual([['Leave now for Home: the 8:14 train.']]);
  });

  it('shouldCue fires again for a new departure', () => {
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    const cued = new Set<string>();
    const first = departureKey('home', 1_790_770_440);
    const next = departureKey('home', 1_790_771_040);
    expect(runTicks(first, cued)).toBe(1);
    expect(shouldCue('now', next, cued)).toBe(true);
    expect(runTicks(next, cued)).toBe(1);
    // Another trip's ride at the same instant is a different departure too.
    expect(shouldCue('now', departureKey('work', 1_790_770_440), cued)).toBe(true);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
  });
});

/** A countdown that only renders the cue's problem (or nothing), as a card does. */
function Countdown({ cueKey, state }: { readonly cueKey: string; readonly state: CountdownState }) {
  const problem = useLeaveNowCue({ key: cueKey, state, announcement: 'Leave now for Gym: the 9:02 train.' });
  expect(cueKey.length).toBeGreaterThan(0);
  expect(problem === null || problem.length > 0).toBe(true);
  return <Text>{problem ?? 'ok'}</Text>;
}

describe('the leave-now cue on a mounted countdown (M7.5)', () => {
  it('a card re-rendering at "now" buzzes once, and a haptic that fails is said on the card', async () => {
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    const key = departureKey('gym', 1_790_773_320);
    const tree = await renderPrimitive(<Countdown cueKey={key} state="soon" />);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    jest.mocked(Haptics.notificationAsync).mockRejectedValueOnce(new Error('haptics engine off'));
    const failing = await renderPrimitive(<Countdown cueKey={key} state="now" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failing.root.findByType(Text).props.children).toBe('The leave-now buzz did not play: Error: haptics engine off');
    const again = await renderPrimitive(<Countdown cueKey={key} state="now" />);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect([tree.root.findByType(Text).props.children, again.root.findByType(Text).props.children]).toEqual(['ok', 'ok']);
  });
});
