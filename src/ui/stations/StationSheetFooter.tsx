import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Linking, PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import { openAppleMaps } from '@/domain/handoff/apple-maps';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';

const WALK_ICON_PT = 17;

export type StationSheetFooterProps = {
  /** Where walk directions lead: the station's coordinate. */
  readonly coordinate: LatLon;
};

/**
 * The station sheet's actions (plan M6.4): walk directions to the station, handed to Apple Maps
 * through the one URL builder (src/domain/handoff/apple-maps.ts, M7.6) — the Maps app first, its web
 * host if the system refuses that. Saving a trip (m7b) and "Route from here" (m10b) join this row.
 *
 * The handoff rule (M1.19): Linking.openURL resolving — with undefined, as React Native's
 * Promise<void> does — means Apple Maps opened; only a rejection (of both URLs) is a failure, and the
 * footer then says so under the button.
 */
export function StationSheetFooter({ coordinate }: StationSheetFooterProps) {
  invariant(isLatLon(coordinate), 'walk directions lead to a real coordinate');
  const [failure, setFailure] = useState<string | null>(null);
  const onWalk = useCallback(() => walkTo(coordinate, setFailure), [coordinate]);
  invariant(failure === null || failure.startsWith(copy.mapsFailed), 'a failure is said in the app\'s words');
  return (
    <View testID="station-sheet-footer" style={styles.footer}>
      <View style={styles.actions}>
        <Pressable
          testID="station-walk-directions"
          accessibilityRole="button"
          accessibilityLabel={copy.walkDirections}
          accessibilityHint={copy.walkDirectionsHint}
          onPress={onWalk}
          style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}>
          <SymbolView name="figure.walk" size={WALK_ICON_PT} tintColor={PlatformColor('label')} />
          <TText variant="headline">{copy.walkDirections}</TText>
        </Pressable>
      </View>
      {failure === null ? null : (
        <TText testID="station-walk-failed" variant="footnote" accessibilityLiveRegion="polite" style={styles.failure}>
          {failure}
        </TText>
      )}
    </View>
  );
}

/** Hands walk directions to Apple Maps; reports a refusal (or clears an old one) through `report`. */
function walkTo(coordinate: LatLon, report: (failure: string | null) => void): void {
  invariant(isLatLon(coordinate), 'walk directions lead to a real coordinate');
  invariant(typeof report === 'function', 'the outcome is reported to the footer');
  openAppleMaps(coordinate, 'walk', (url) => Linking.openURL(url)).then(
    (opened) => report(opened.ok ? null : `${copy.mapsFailed}: ${opened.error.message}`),
    (error: unknown) => report(`${copy.mapsFailed}: ${error instanceof Error ? error.message : String(error)}`),
  );
}

const styles = StyleSheet.create({
  footer: { gap: SPACING.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: 44,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
  },
  pressed: { opacity: 0.6 },
  failure: { color: PlatformColor('systemRed') },
});
