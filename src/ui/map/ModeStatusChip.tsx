import { SymbolView } from 'expo-symbols';
import { PlatformColor, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { MODE_NAMES } from '../a11y';
import { Glass } from '../primitives/Glass';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { type ModeStatusNote, useModeStatusNotes } from './use-mode-status';
import { MIN_HIT_AREA_PT } from './vehicleVisual';

export type ModeStatusChipProps = {
  /** Where its top sits, in points from the top of the map (below the status pill). */
  readonly topPt: number;
};

const ICON_PT = 15;

/**
 * The map's mode-status chip (mfix4): floating glass below the status pill that says a line is closed
 * and when it opens — "Metromover closed · opens 5:30 AM" — one row per closed mode with no live
 * vehicle (use-mode-status.ts decides). Nothing at all while every mode runs, so the map stays clear.
 * One VoiceOver element ("Metromover closed, opens 5:30 AM"); not a button (it leads nowhere), so map
 * touches pass through it.
 */
export function ModeStatusChip({ topPt }: ModeStatusChipProps) {
  const notes = useModeStatusNotes();
  invariant(Number.isFinite(topPt) && topPt >= 0, 'the chip sits on the map');
  invariant(notes.every((note) => note.text.length > 0), 'every row says something');
  if (notes.length === 0) {
    return null;
  }
  return (
    <View testID="mode-status-chip" pointerEvents="none" style={[styles.slot, { top: topPt }]}>
      <Glass style={styles.chip} accessible accessibilityRole="text" accessibilityLabel={notes.map((note) => spoken(note.text)).join('. ')}>
        {notes.map((note) => <ModeStatusRow key={note.mode} note={note} />)}
      </Glass>
    </View>
  );
}

/** One closed mode: a sleeping-moon symbol (decorative; the words say it all) and its line. */
function ModeStatusRow({ note }: { readonly note: ModeStatusNote }) {
  invariant(note.text.includes(MODE_NAMES[note.mode]), 'a row names its mode');
  invariant(note.text.length > 0, 'a row says something');
  return (
    <View style={styles.row}>
      <SymbolView name="moon.zzz" size={ICON_PT} tintColor={PlatformColor('secondaryLabel')} />
      <TText testID={`mode-status-${note.mode}`} variant="subhead" numberOfLines={2} style={styles.text}>
        {note.text}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  // Left of the control stack's 44 pt column, like the caption whose slot it shares.
  slot: { position: 'absolute', left: SPACING.md, right: SPACING.md + MIN_HIT_AREA_PT + SPACING.sm, alignItems: 'flex-start' },
  chip: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, gap: SPACING.xxs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  // Wraps (rather than truncating the opening time) at large Dynamic Type sizes.
  text: { flexShrink: 1 },
});

/** A row as VoiceOver reads it: the middle dot becomes a pause. */
function spoken(text: string): string {
  invariant(text.length > 0, 'a row says something');
  const words = text.split(' · ').join(', ');
  invariant(!words.includes('·'), 'no middle dot is read aloud');
  return words;
}
