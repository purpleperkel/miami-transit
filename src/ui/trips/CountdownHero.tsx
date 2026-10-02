import { PlatformColor, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import type { CountdownState } from './countdown';
import type { TripWalk } from './trip-card';
import { heroOf, rideLine, type Timed } from './trip-copy';
import { departureKey, useLeaveNowCue } from './useLeaveNowCue';

export type CountdownHeroProps = {
  readonly tripId: string;
  readonly tripName: string;
  readonly status: Timed;
  readonly walk: TripWalk | null;
  readonly nowS: number;
};

/** The hero's colour per countdown state (plan §4: "soon" is orange; a missed train steps back). */
const STATE_COLOR: Readonly<Record<CountdownState, string>> = {
  clock: 'label',
  normal: 'label',
  soon: 'systemOrange',
  now: 'systemGreen',
  missed: 'secondaryLabel',
};

/**
 * The trip card's hero (plan §4, M7.8): "Leave in 6 min" in the 56 pt SF Rounded tabular `hero` style,
 * from M7.2's countdown states (./countdown), with the train it counts to and the walk it allows for
 * beneath. At "Leave now" it cues once per departure: one haptic and a VoiceOver announcement (M7.5).
 */
export function CountdownHero({ tripId, tripName, status, walk, nowS }: CountdownHeroProps) {
  const hero = heroOf(status, nowS);
  const problem = useLeaveNowCue({
    key: departureKey(tripId, status.current.ride.depEpoch),
    state: hero.countdown.state,
    announcement: `Leave now for ${tripName}: the ${status.current.departClock} train.`,
  });
  invariant(hero.text.length > 0, 'the hero always says something');
  invariant(problem === null || problem.length > 0, 'a cue problem says why');
  return (
    <View testID="countdown-hero" style={styles.hero} accessible accessibilityLabel={`${hero.label} ${rideLine(status, walk)}.`}>
      <TText testID="countdown-hero-text" variant="hero" numberOfLines={1} adjustsFontSizeToFit style={{ color: PlatformColor(STATE_COLOR[hero.countdown.state]) }}>
        {hero.text}
      </TText>
      <TText testID="countdown-hero-ride" variant="subhead" tone="secondary">
        {rideLine(status, walk)}
      </TText>
      {problem === null ? null : (
        <TText testID="countdown-hero-problem" variant="footnote" style={styles.problem}>
          {problem}
        </TText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: SPACING.xxs },
  problem: { color: PlatformColor('systemRed') },
});
