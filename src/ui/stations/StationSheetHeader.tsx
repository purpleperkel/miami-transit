import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { LineId } from '@/domain/lines/line-catalog';
import type { Mode } from '@/domain/network/stations';
import { invariant } from '@/lib/invariant';

import { MODE_NAMES } from '../a11y';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { LineStrip } from './LineStrip';

export type StationSheetHeaderProps = {
  readonly mode: Mode;
  /** The lines stopping at the station, in line order. */
  readonly lines: readonly LineId[];
  /**
   * The verdict slot (R7): whatever the route passes here — m7c's HurryCard, "hurry or chill" for this
   * station — renders inside the header, under the lines. Nothing passed, nothing drawn.
   */
  readonly verdict?: ReactNode;
};

/**
 * The top of the station sheet (plan M6.4): the lines that stop here and which system it is. The
 * station's name is the sheet's native title (the route sets it), so it is not repeated here. The
 * verdict slot is a plain prop — this header knows nothing about how a verdict is reached.
 */
export function StationSheetHeader({ mode, lines, verdict }: StationSheetHeaderProps) {
  invariant(lines.length > 0, 'a station is served by at least one line');
  invariant(MODE_NAMES[mode] !== undefined, `"${mode}" is a system riders have a name for`);
  const hasVerdict = verdict !== undefined && verdict !== null && verdict !== false;
  return (
    <View testID="station-sheet-header" style={styles.header}>
      <View style={styles.lines}>
        <LineStrip lines={lines} testID="station-sheet-lines" />
        <TText variant="footnote" tone="secondary">
          {MODE_NAMES[mode]}
        </TText>
      </View>
      {hasVerdict ? <View testID="station-sheet-verdict">{verdict}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: SPACING.sm },
  lines: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
});
