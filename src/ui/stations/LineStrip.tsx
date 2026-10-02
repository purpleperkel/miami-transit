import { StyleSheet, View } from 'react-native';

import { type LineId, lineById } from '@/domain/lines/line-catalog';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { LineBadge } from '../primitives/LineBadge';
import { SPACING } from '../tokens';

export type LineStripProps = {
  /** The lines stopping at the station, in line order: one segment each. */
  readonly lines: readonly LineId[];
  readonly testID?: string;
};

/**
 * Which lines stop at a station (plan M6.5): one segment per line — the line's badge, filled with its
 * colour and lettered with its name — so a trunk station shows Green and Orange, the Airport Orange
 * alone. Never colour alone (§4): every segment carries its name, and VoiceOver reads the strip as one
 * phrase naming every line ("Green Line and Orange Line").
 */
export function LineStrip({ lines, testID = 'line-strip' }: LineStripProps) {
  invariant(lines.length > 0, 'a station is served by at least one line');
  invariant(new Set(lines).size === lines.length, 'each line is one segment');
  const label = copy.lineNames(lines.map((id) => lineById(id).name));
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={label} style={styles.strip}>
      {lines.map((id) => (
        <LineBadge key={id} lineId={id} testID={`${testID}-segment-${id}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xxs },
});
