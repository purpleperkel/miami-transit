import { Pressable, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { Glass } from '../primitives/Glass';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { MIN_HIT_AREA_PT } from './vehicleVisual';

export type MapCaptionProps = {
  readonly text: string;
  /** Where its top sits, in points from the top of the map. */
  readonly topPt: number;
  /** A tap on the caption puts it away. */
  readonly onDismiss: () => void;
};

/**
 * The map's caption (mfix3 §5): a small glass label naming what was just tapped — a station, a vehicle
 * ("Green Line train to Dadeland South · live, 40 s ago"), the lines under a press — or a one-line note.
 * Floating chrome, so glass (plan §4); VoiceOver announces it as it changes. It sits left of the control
 * stack, clear of its 44 pt column.
 */
export function MapCaption({ text, topPt, onDismiss }: MapCaptionProps) {
  invariant(text.trim().length > 0, 'a caption says something');
  invariant(Number.isFinite(topPt) && topPt >= 0, 'a caption sits on the map');
  return (
    <Pressable testID="map-caption" accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityHint="Tap to dismiss" onPress={onDismiss} style={[styles.slot, { top: topPt }]}>
      <Glass style={styles.label}>
        <TText testID="map-caption-text" variant="subhead" numberOfLines={2}>
          {text}
        </TText>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: { position: 'absolute', left: SPACING.md, right: SPACING.md + MIN_HIT_AREA_PT + SPACING.sm, alignItems: 'flex-start' },
  label: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
});
