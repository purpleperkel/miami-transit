import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import type { Notice } from './settings-actions';
import { paceDraft, paceText } from './settings-text';
import { NoticeText, SettingsRow, SettingsSection, settingsStyles as styles } from './SettingsSection';
import { DEFAULT_JOG_MPS, DEFAULT_WALK_MPS, readWalkingPace, saveWalkingPace, type WalkingPace } from './walking-pace';

/**
 * Plan M8b.1 "Walking pace": the walk and jog speeds hurry-or-chill weighs (M7c), shown in m/s (and
 * mph), editable. Saving goes through walking-pace.ts, which refuses a jog no faster than the walk.
 */
export function WalkingPaceSection() {
  const [pace, setPace] = useState<WalkingPace>(() => readWalkingPace());
  const [walk, setWalk] = useState(() => paceDraft(pace.walkMps));
  const [jog, setJog] = useState(() => paceDraft(pace.jogMps));
  const [notice, setNotice] = useState<Notice | null>(null);
  invariant(pace.jogMps > pace.walkMps, 'the paces in effect jog faster than they walk');
  invariant(typeof walk === 'string' && typeof jog === 'string', 'the fields hold text');
  return (
    <SettingsSection title="Walking pace" footer={`Hurry or chill weighs these. Defaults: walk ${DEFAULT_WALK_MPS}, jog ${DEFAULT_JOG_MPS} m/s.`}>
      <SettingsRow label="Walk" value={paceText(pace.walkMps)} testID="pace-walk" />
      <SettingsRow label="Jog" value={paceText(pace.jogMps)} testID="pace-jog" />
      <View style={styles.controls}>
        <TextInput testID="pace-input-walk" accessibilityLabel="Walking pace, metres per second" value={walk} onChangeText={setWalk} keyboardType="decimal-pad" style={styles.input} />
        <TextInput testID="pace-input-jog" accessibilityLabel="Jogging pace, metres per second" value={jog} onChangeText={setJog} keyboardType="decimal-pad" style={styles.input} />
        <Pressable testID="pace-save" accessibilityRole="button" onPress={() => setNotice(applyPace(walk, jog, setPace))} style={styles.button}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
      <NoticeText notice={notice} testID="pace-notice" />
    </SettingsSection>
  );
}

/** Saves the typed paces (a decimal comma reads as a point); on success hands the saved pair to `onSaved`. */
function applyPace(walkText: string, jogText: string, onSaved: (pace: WalkingPace) => void): Notice {
  invariant(typeof onSaved === 'function', 'a saved pace is handed back');
  const saved = saveWalkingPace({ walkMps: parsePace(walkText), jogMps: parsePace(jogText) });
  if (saved.ok) {
    onSaved(saved.value);
  }
  const notice: Notice = saved.ok
    ? { tone: 'ok', text: `Saved: walk ${paceDraft(saved.value.walkMps)}, jog ${paceDraft(saved.value.jogMps)} m/s.` }
    : { tone: 'error', text: `Not saved: ${saved.error.message}.` };
  invariant(notice.text.length > 0, 'saving always says what happened');
  return notice;
}

/** A typed pace as a number: NaN for anything that is not a plain decimal, which saveWalkingPace refuses. */
function parsePace(text: string): number {
  const normalised = text.trim().replace(',', '.');
  const mps = /^\d+(\.\d+)?$|^\.\d+$/.test(normalised) ? Number(normalised) : Number.NaN;
  invariant(typeof mps === 'number', 'a parsed pace is a number');
  invariant(Number.isNaN(mps) || mps >= 0, 'a parsed pace is never negative');
  return mps;
}
