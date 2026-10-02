import { PlatformColor, ScrollView, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { EmptyState } from '../primitives/EmptyState';
import { SPACING } from '../tokens';

/**
 * The Trips tab (plan M5.5). Saved trips with their "Leave in N min" countdown arrive with M7; until
 * then the tab shows its real empty state. The title is the tab's native large-title header
 * (trips/_layout.tsx); the ScrollView is the screen's first scroll view, which iOS insets under it.
 */
export function TripsScreen() {
  invariant(typeof EmptyState === 'function', 'the design system provides EmptyState');
  invariant(SPACING.md > 0, 'the screen is laid out on the spacing scale');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <EmptyState testID="trips-empty" title="No trips yet" message="Trips you save appear here, counting down to when you need to leave." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemBackground') },
  content: { padding: SPACING.md },
});
