import { useCallback, useState } from 'react';
import { Linking, PlatformColor, StyleSheet, View } from 'react-native';

import { openAppleMaps } from '@/domain/handoff/apple-maps';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { ActionButton } from '../primitives/ActionButton';
import { TText } from '../primitives/TText';
import { openPlanSheet } from '../sheets';
import { SPACING } from '../tokens';

export type StationSheetFooterProps = {
  /** The station the sheet is about: where "Route from here" starts. */
  readonly stationKey: string;
  /** Where walk directions lead: the station's coordinate. */
  readonly coordinate: LatLon;
};

/**
 * The station sheet's actions (plan M6.4): walk directions to the station, handed to Apple Maps
 * through the one URL builder (src/domain/handoff/apple-maps.ts, M7.6) — the Maps app first, its web
 * host if the system refuses that — and "Route from here" (M10b), which opens the route options sheet
 * starting at this station. Saving a trip (m7b) joins this row.
 *
 * The handoff rule (M1.19): Linking.openURL resolving — with undefined, as React Native's
 * Promise<void> does — means Apple Maps opened; only a rejection (of both URLs) is a failure, and the
 * footer then says so under the button.
 */
export function StationSheetFooter({ stationKey, coordinate }: StationSheetFooterProps) {
  invariant(isLatLon(coordinate), 'walk directions lead to a real coordinate');
  invariant(stationKey.includes(':'), `a route starts at a station keyed mode:name, got "${stationKey}"`);
  const [failure, setFailure] = useState<string | null>(null);
  const onWalk = useCallback(() => walkTo(coordinate, setFailure), [coordinate]);
  const onRoute = useCallback(() => openPlanSheet({ fromStation: stationKey }), [stationKey]);
  return (
    <View testID="station-sheet-footer" style={styles.footer}>
      <View style={styles.actions}>
        <ActionButton testID="station-walk-directions" symbol="figure.walk" label={copy.walkDirections} hint={copy.walkDirectionsHint} onPress={onWalk} />
        <ActionButton testID="station-route-from-here" symbol="arrow.triangle.turn.up.right.diamond" label={copy.routeFromHere} hint={copy.routeFromHereHint} onPress={onRoute} />
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
  failure: { color: PlatformColor('systemRed') },
});
