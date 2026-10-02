import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import { type DirectionsMode, openAppleMaps, type OpenUrl } from '@/domain/handoff/apple-maps';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { copy } from '@/ui/copy';
import { ActionButton } from '@/ui/primitives/ActionButton';
import { TText } from '@/ui/primitives/TText';
import { SPACING } from '@/ui/tokens';

/**
 * /directions?name=…&lat=…&lon=… — Apple Maps directions to a place (plan M7.6), by public transit
 * (dirflg=r) or on foot (dirflg=w): a short formSheet (root _layout.tsx: DIRECTIONS_OPTIONS), opened from a
 * saved trip for the station it leaves from. The URL is built and opened by the ONE handoff module
 * (src/domain/handoff/apple-maps.ts, ruling R5); this screen hands it React Native's Linking.openURL and
 * never reads that promise itself — the handoff rule (M1.19: a resolution, of any value, means Apple Maps
 * opened; only a rejection of both URLs is a failure) lives in the tested module alone.
 */

/** React Native's opener, handed to the handoff as is: only the handoff decides what its promise means. */
const openURL: OpenUrl = function openURL(url: string): Promise<void> {
  invariant(url.length > 0, 'the handoff opens a URL');
  invariant(typeof Linking.openURL === 'function', 'React Native opens URLs');
  return Linking.openURL(url);
};

/** The place the screen was opened for, from its params; null when they do not name one. */
export function placeOf(params: { readonly name?: string; readonly lat?: string; readonly lon?: string }): (LatLon & { readonly name: string }) | null {
  invariant(typeof params === 'object' && params !== null, 'the screen has its params');
  const place = { name: params.name ?? '', latitude: Number(params.lat), longitude: Number(params.lon) };
  const valid = place.name.length > 0 && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) && isLatLon(place);
  invariant(!valid || place.name.trim().length > 0, 'a place has a name');
  return valid ? place : null;
}

export default function DirectionsRoute() {
  const params = useLocalSearchParams<{ name?: string; lat?: string; lon?: string }>();
  const place = placeOf(params);
  invariant(place !== null, `directions are opened for a named place, got ${JSON.stringify(params)}`);
  const [failure, setFailure] = useState<string | null>(null);
  const go = useCallback((mode: DirectionsMode) => handOff(place, mode, setFailure), [place]);
  invariant(failure === null || failure.startsWith(copy.mapsFailed), 'a failure is said in the app\'s words');
  return (
    <ScrollView testID="directions" contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <TText variant="title">{place.name}</TText>
      <View style={styles.actions}>
        <ActionButton testID="directions-transit" symbol="tram" label="By transit" hint="Opens Apple Maps with public transit directions" onPress={() => go('transit')} />
        <ActionButton testID="directions-walk" symbol="figure.walk" label="Walking" hint="Opens Apple Maps with walking directions" onPress={() => go('walk')} />
      </View>
      {failure === null ? null : (
        <TText testID="directions-failed" variant="footnote" accessibilityLiveRegion="polite" style={styles.failure}>
          {failure}
        </TText>
      )}
    </ScrollView>
  );
}

/** Hands the directions to Apple Maps through the handoff module; reports a refusal (or clears an old one). */
function handOff(place: LatLon, mode: DirectionsMode, report: (failure: string | null) => void): void {
  invariant(isLatLon(place), 'directions lead to a real coordinate');
  invariant(typeof report === 'function', 'the outcome is reported to the screen');
  openAppleMaps(place, mode, openURL).then(
    (opened) => report(opened.ok ? null : `${copy.mapsFailed}: ${opened.error.message}`),
    (error: unknown) => report(`${copy.mapsFailed}: ${error instanceof Error ? error.message : String(error)}`),
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  failure: { color: PlatformColor('systemRed') },
});
