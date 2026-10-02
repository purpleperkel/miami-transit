import * as Haptics from 'expo-haptics';
import { act } from 'react-test-renderer';

import { type HurryDeparture, type HurryVerdict, hurryVerdict } from '../../../domain/hurry/verdict';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { TText } from '../../primitives/TText';
import { type HurryCopyContext, hurrySentence } from '../copy';
import { HurryCard } from '../HurryCard';

// test-time mock of native module
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(() => Promise.resolve()), NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' } }));

/**
 * Plan M7c.2: the HurryCard — the verdict word as the hero, the rest of the copy under it, a Live or
 * Scheduled badge, ONE VoiceOver sentence, and one Warning haptic per JOG departure (remembered
 * module-wide, so every test below jogs for trains of its own).
 */

const CTX: HurryCopyContext = { now: 0, clock: (epoch) => (epoch === 300 ? '2:14' : '9:59') };
const notify = Haptics.notificationAsync as jest.Mock;

beforeEach(() => notify.mockClear());
afterEach(async () => {
  await unmountAll();
});

/** The engine's verdict, 400 m from the platform, for trains at `epochs` (each keyed `${tag}:${epoch}`). */
function verdict(tag: string, epochs: readonly number[], live = false): HurryVerdict {
  const departures: HurryDeparture[] = epochs.map((epoch) => ({ key: `${tag}:${epoch}`, epoch, live, lineId: 'GREEN', headsign: 'Dadeland South' }));
  const made = hurryVerdict({ now: 0, walkMeters: 400, departures });
  expect(made.departure?.key).toBe(epochs.length === 0 ? undefined : `${tag}:${epochs[0]}`);
  expect(made.live).toBe(live && epochs.length > 0);
  return made;
}

/** The card's badge word, as it is drawn. */
async function badgeOf(v: HurryVerdict): Promise<string> {
  const tree = await renderPrimitive(<HurryCard verdict={v} ctx={CTX} />);
  const words = hostsByTestID(tree.root, 'hurry-card-badge-word');
  expect(words).toHaveLength(1);
  expect(typeof words[0]?.props.children).toBe('string');
  return words[0]?.props.children as string;
}

describe('the HurryCard (M7c.2): what it shows', () => {
  it('live verdict shows the Live badge', async () => {
    expect(await badgeOf(verdict('badge-live', [600], true))).toBe('Live');
    expect(await badgeOf(verdict('badge-missed-live', [150, 900], true))).toBe('Live');
  });

  it('scheduled verdict shows the Scheduled badge', async () => {
    expect(await badgeOf(verdict('badge-scheduled', [600]))).toBe('Scheduled');
    expect(await badgeOf(verdict('badge-none', []))).toBe('Scheduled');
  });

  it('a stale live verdict shows how old its time is', async () => {
    const tree = await renderPrimitive(<HurryCard verdict={verdict('badge-stale', [600], true)} ctx={CTX} freshness={{ kind: 'stale', ageS: 200 }} />);
    expect(hostsByTestID(tree.root, 'hurry-card-badge-word')[0]?.props.children).toBe('Live · 3 min old');
  });

  it('hero uses the hero variant', async () => {
    const tree = await renderPrimitive(<HurryCard verdict={verdict('hero', [300, 1200])} ctx={CTX} title="To Dadeland South" />);
    const heroes = tree.root.findAllByType(TText).filter((text) => text.props.variant === 'hero');
    expect(heroes.map((hero) => hero.props.children)).toEqual(['Jog']);
    expect(hostsByTestID(tree.root, 'hurry-card-detail')[0]?.props.children).toBe('makes the 2:14 with 1 min spare');
    expect(hostsByTestID(tree.root, 'hurry-card-title')[0]?.props.children).toBe('To Dadeland South');
  });

  it('accessibility label is the VoiceOver sentence', async () => {
    const v = verdict('label', [600], true);
    const tree = await renderPrimitive(<HurryCard verdict={v} ctx={CTX} />);
    const card = hostsByTestID(tree.root, 'hurry-card')[0];
    expect(card?.props.accessible).toBe(true);
    expect(card?.props.accessibilityLabel).toBe(hurrySentence(v, CTX));
    expect(card?.props.accessibilityLabel).toBe('Chill, a walk makes the 9:59 train with 3 minutes to spare, going by live times.');
  });
});

describe('the HurryCard (M7c.2): the JOG haptic', () => {
  it('JOG fires one Warning haptic per departure', async () => {
    const jog = verdict('once', [300, 1200]);
    const tree = await renderPrimitive(<HurryCard verdict={jog} ctx={CTX} />);
    await act(async () => tree.update(<HurryCard verdict={jog} ctx={{ ...CTX, now: 5 }} />));
    await renderPrimitive(<HurryCard verdict={verdict('once', [300, 1200])} ctx={CTX} testID="second-card" />);
    expect(notify.mock.calls).toEqual([[Haptics.NotificationFeedbackType.Warning]]);
    expect(Haptics.NotificationFeedbackType.Warning).toBe('warning');
  });

  it('JOG fires again for a new departure', async () => {
    const tree = await renderPrimitive(<HurryCard verdict={verdict('again', [300, 1200])} ctx={CTX} />);
    await act(async () => tree.update(<HurryCard verdict={verdict('again', [301, 1200])} ctx={CTX} />));
    expect(notify.mock.calls).toEqual([['warning'], ['warning']]);
    // A MISSED verdict whose next train needs a jog asks for one too.
    await renderPrimitive(<HurryCard verdict={verdict('again-missed', [150, 300])} ctx={CTX} />);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('CHILL fires no haptic', async () => {
    await renderPrimitive(<HurryCard verdict={verdict('chill', [600])} ctx={CTX} />);
    await renderPrimitive(<HurryCard verdict={verdict('not-worth-it', [300, 500])} ctx={CTX} />);
    expect(notify).not.toHaveBeenCalled();
    expect(verdict('chill', [600]).kind).toBe('CHILL');
  });

  it('a haptic that cannot play says so on the card', async () => {
    notify.mockImplementationOnce(() => Promise.reject(new Error('the haptic engine is off')));
    const tree = await renderPrimitive(<HurryCard verdict={verdict('broken', [300, 1200])} ctx={CTX} />);
    expect(hostsByTestID(tree.root, 'hurry-card-cue-problem')[0]?.props.children).toBe('The jog buzz did not play: Error: the haptic engine is off');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
