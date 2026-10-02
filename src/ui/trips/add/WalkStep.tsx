import { useCallback, useState } from 'react';
import { PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import { MAX_WALK_OVERRIDE_MIN } from '@/domain/trips/walk-estimate';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, type Result } from '@/lib/result';
import { detach } from '@/live/detach';

import { askForLocation, currentPosition } from '../../map/use-user-location';
import { ActionButton } from '../../primitives/ActionButton';
import { TText } from '../../primitives/TText';
import { SPACING } from '../../tokens';
import { goToConfirm } from './add-trip';

/**
 * The add-trip flow's third step (M7.9): how the walk to the boarding station is known — from wherever
 * the phone is each time (no reminders: the leave-by moves with the rider), from here (this spot is
 * saved as the trip's start), or a fixed number of minutes (the per-trip override, plan R13).
 */

/** The fixed walk starts here and moves by one minute a tap. */
export const DEFAULT_WALK_MIN = 5;

/** Asks for location, then reads the position once; why not, when it cannot. */
export function positionForStart(): Promise<Result<LatLon, string>> {
  invariant(typeof askForLocation === 'function' && typeof currentPosition === 'function', 'the location module reads positions');
  const read = askForLocation().then((grant) => (grant.ok ? currentPosition() : err('Location is off, so this spot cannot be saved as the start.')));
  invariant(typeof read.then === 'function', 'the position arrives later');
  return read;
}

/** Reads where the phone is and moves on with it as the trip's start; why not goes to `report`. */
function startFromHere(from: string, to: string, report: (problem: string | null) => void): void {
  invariant(from !== to, 'the flow knows both stations');
  invariant(typeof report === 'function', 'a problem is shown on the step');
  report(null);
  detach(
    positionForStart().then((start) => (start.ok ? goToConfirm(from, to, { kind: 'start', start: start.value }) : report(start.error))),
    (message) => report(`The position could not be read: ${message}`),
  );
}

export function WalkStep({ from, to }: { readonly from: string; readonly to: string }) {
  invariant(from.includes(':') && to.includes(':') && from !== to, 'the flow knows both stations');
  const [minutes, setMinutes] = useState(DEFAULT_WALK_MIN);
  const [problem, setProblem] = useState<string | null>(null);
  const fromHere = useCallback(() => startFromHere(from, to, setProblem), [from, to]);
  invariant(minutes >= 0 && minutes <= MAX_WALK_OVERRIDE_MIN, 'the walk stays in range');
  return (
    <ScrollView testID="add-trip-walk" contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <TText variant="subhead" tone="secondary">
        How far is the walk to the station? The countdown leaves time for it.
      </TText>
      <ActionButton testID="walk-each-time" symbol="location" label="From wherever I am" hint="Measures the walk from where the phone is each time; no reminders" onPress={() => goToConfirm(from, to, { kind: 'here-each-time' })} />
      <ActionButton testID="walk-from-here" symbol="mappin.and.ellipse" label="From here" hint="Saves where you are now as the trip's start" onPress={fromHere} />
      <View style={styles.minutes}>
        <ActionButton testID="walk-less" symbol="minus" label="Less" hint="One minute less" onPress={() => setMinutes((m) => Math.max(0, m - 1))} />
        <TText testID="walk-minutes" variant="title">{`${minutes} min`}</TText>
        <ActionButton testID="walk-more" symbol="plus" label="More" hint="One minute more" onPress={() => setMinutes((m) => Math.min(MAX_WALK_OVERRIDE_MIN, m + 1))} />
      </View>
      <ActionButton testID="walk-fixed" symbol="figure.walk" label={`A ${minutes} min walk`} hint="Uses this many minutes for the walk every time" onPress={() => goToConfirm(from, to, { kind: 'minutes', minutes })} />
      {problem === null ? null : (
        <TText testID="walk-problem" variant="footnote" style={styles.problem}>
          {problem}
        </TText>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  minutes: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  problem: { color: PlatformColor('systemRed') },
});
