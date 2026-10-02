import { SymbolView } from 'expo-symbols';
import { PlatformColor, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { type DataStatus, statusFace } from '../dataStatus';
import { SPACING } from '../tokens';
import { TText } from './TText';

/**
 * How fresh a list of departure times is (plan M6.2): `live` (realtime predictions within their
 * provider's fresh threshold), `stale` (the newest predictions are older than that, `ageS` old), or
 * `scheduled` (timetable times). These are the map pill's own statuses (src/ui/dataStatus.ts), so a
 * row header and the pill use the same icon and the same word for the same state.
 */
export type Freshness = Extract<DataStatus, { readonly kind: 'live' | 'stale' | 'scheduled' }>;
export const FRESHNESS_KINDS = ['live', 'stale', 'scheduled'] as const satisfies readonly Freshness['kind'][];

const ICON_PT = 13;

export type FreshnessIndicatorProps = {
  readonly freshness: Freshness;
  readonly testID?: string;
};

/**
 * An SF Symbol AND a word for every freshness state — never colour alone (§4 accessibility): radio
 * waves + "Live", a clock + "Live · 2 min old", a calendar + "Scheduled". It sits still in a list
 * (only the map pill pulses), and VoiceOver reads the word.
 */
export function FreshnessIndicator({ freshness, testID }: FreshnessIndicatorProps) {
  invariant((FRESHNESS_KINDS as readonly string[]).includes(freshness.kind), `"${freshness.kind}" is a freshness state`);
  const face = statusFace(freshness);
  invariant(face.icon.length > 0 && face.text.trim().length > 0, 'every freshness state has an icon and a word');
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={face.text} style={styles.row}>
      <SymbolView testID={testID === undefined ? undefined : `${testID}-icon`} name={face.icon} size={ICON_PT} tintColor={PlatformColor('secondaryLabel')} />
      <TText testID={testID === undefined ? undefined : `${testID}-word`} variant="footnote" tone="secondary" numberOfLines={1}>
        {face.text}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xxs },
});
