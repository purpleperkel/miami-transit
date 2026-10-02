import { PlatformColor, StyleSheet, View } from 'react-native';

import type { HurryVerdict } from '@/domain/hurry/verdict';
import { invariant } from '@/lib/invariant';

import { type Freshness, FreshnessIndicator } from '../primitives/FreshnessIndicator';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { actionableVerdict, type HurryCopyContext, hurryParts, hurrySentence } from './copy';
import { useJogCue } from './jog-cue';

/**
 * Plan M7c.2: one hurry-or-chill verdict, readable at a glance. The verdict word is the hero (m5a's
 * `hero` type, sized down to fit one line: "Chill", "Jog", "Not worth it"), the rest of the copy under
 * it ("makes the 2:14 with 1 min spare"), and a badge naming where the train's time comes from — "Live",
 * "Live · 2 min old" or "Scheduled", the same icon and word as every departure list. VoiceOver reads ONE
 * full sentence instead (hurrySentence), which says "live" or "scheduled" itself because the badge sits
 * behind it. A JOG verdict buzzes once per departure (jog-cue.ts).
 */

export type HurryCardProps = {
  readonly verdict: HurryVerdict;
  readonly ctx: HurryCopyContext;
  /** Which way the verdict looks, e.g. "To Dadeland South"; null when there is one way only. */
  readonly title?: string | null;
  /** Where the train's time comes from; by default Live or Scheduled from the verdict itself. */
  readonly freshness?: Freshness;
  readonly testID?: string;
};

const LIVE: Freshness = Object.freeze({ kind: 'live' });
const SCHEDULED: Freshness = Object.freeze({ kind: 'scheduled' });

export function HurryCard({ verdict, ctx, title = null, freshness, testID = 'hurry-card' }: HurryCardProps) {
  const live = actionableVerdict(verdict).live;
  const badge = freshness ?? (live ? LIVE : SCHEDULED);
  invariant((badge.kind === 'scheduled') === !live, 'the badge names the source of the train the verdict is about');
  const { headline, detail } = hurryParts(verdict, ctx);
  const sentence = hurrySentence(verdict, ctx);
  const cueProblem = useJogCue(verdict);
  invariant(sentence.length > headline.length, 'the spoken sentence says more than the hero word');
  return (
    <View testID={testID} accessible accessibilityLabel={sentence} style={styles.card}>
      <View style={styles.top}>
        {title === null ? null : (
          <TText testID={`${testID}-title`} variant="footnote" tone="secondary" numberOfLines={1} style={styles.title}>
            {title}
          </TText>
        )}
        <FreshnessIndicator testID={`${testID}-badge`} freshness={badge} />
      </View>
      <TText testID={`${testID}-hero`} variant="hero" numberOfLines={1} adjustsFontSizeToFit>
        {headline}
      </TText>
      {detail === null ? null : (
        <TText testID={`${testID}-detail`} variant="headline">
          {detail}
        </TText>
      )}
      {cueProblem === null ? null : (
        <TText testID={`${testID}-cue-problem`} variant="footnote" tone="secondary">
          {cueProblem}
        </TText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.xxs,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  title: { flex: 1 },
});
