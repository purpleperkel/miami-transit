import { PlatformColor, StyleSheet, View } from 'react-native';

import type { OpenUrl } from '@/domain/handoff/apple-maps';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { ActionButton } from '../primitives/ActionButton';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { openDirections, transitDirectionsUrl } from './leg-actions';
import type { RecentPlace } from './recent-places';
import { linkingOpenURL, useOpenLink } from './use-open-link';

export type PlanUnavailableProps = {
  /** Why there are no options (Transitous unreachable, no location, no route found). */
  readonly reason: string;
  /** Where the rider wants to go: Apple Maps plans it instead. */
  readonly destination: RecentPlace;
  /** React Native's Linking.openURL unless a test passes its own. */
  readonly openURL?: OpenUrl;
};

/**
 * Plan M10b.2: when the sheet has no route options — Transitous did not answer (the polite client's
 * { kind: 'unavailable' }), found nothing, or the start is unknown — the rider still gets there: "Open
 * in Apple Maps" asks Apple Maps for transit directions to the destination (dirflg=r, leg-actions.ts),
 * from wherever the rider is. A refusal is said under the button.
 */
export function PlanUnavailable({ reason, destination, openURL = linkingOpenURL }: PlanUnavailableProps) {
  const { failure, open } = useOpenLink(openDirections, openURL);
  invariant(reason.trim().length > 0, 'the sheet says why there are no options');
  invariant(destination.name.trim().length > 0, 'the destination is named');
  return (
    <View testID="plan-unavailable" style={styles.box}>
      <TText variant="headline" accessibilityRole="header">
        {copy.routesUnavailable}
      </TText>
      <TText testID="plan-unavailable-reason" variant="subhead" tone="secondary">
        {reason}
      </TText>
      <ActionButton testID="plan-open-apple-maps" symbol="map" label={copy.openInAppleMaps} hint={copy.openInAppleMapsHint} onPress={() => open(transitDirectionsUrl(destination))} />
      {failure === null ? null : (
        <TText testID="plan-apple-maps-failed" variant="footnote" accessibilityLiveRegion="polite" style={styles.failure}>
          {failure}
        </TText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: SPACING.xs, alignItems: 'flex-start', paddingVertical: SPACING.md },
  failure: { color: PlatformColor('systemRed') },
});
