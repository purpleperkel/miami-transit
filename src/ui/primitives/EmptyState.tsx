import { StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { SPACING } from '../tokens';
import { TText } from './TText';

export type EmptyStateProps = {
  /** What is missing, in a few words ("No trips yet"). */
  readonly title: string;
  /** What will fill the space, or how to fill it. */
  readonly message: string;
  readonly testID?: string;
};

/**
 * The design system's empty state: a screen region with nothing to show yet says so plainly, with a
 * headline and one line of guidance, centred (plan M5.5: the Trips tab before any trip is saved).
 * Both texts scale with Dynamic Type through TText.
 */
export function EmptyState({ title, message, testID }: EmptyStateProps) {
  invariant(title.trim().length > 0, 'an empty state names what is missing');
  invariant(message.trim().length > 0, 'an empty state says what will fill it');
  return (
    <View testID={testID} style={styles.container}>
      <TText variant="headline" accessibilityRole="header" style={styles.text}>
        {title}
      </TText>
      <TText variant="subhead" tone="secondary" style={styles.text}>
        {message}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: SPACING.xs, paddingHorizontal: SPACING.xl, paddingVertical: SPACING.xxl },
  text: { textAlign: 'center' },
});
