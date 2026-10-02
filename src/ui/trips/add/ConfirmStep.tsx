import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useState } from 'react';
import { PlatformColor, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import type { SavedTripError } from '@/data/saved-trips-repo';
import { type TripBook, useUserDb } from '@/data/user-db-provider';
import { useScheduleDb } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';
import type { Result } from '@/lib/result';
import { detach } from '@/live/detach';

import { wallClockNowS } from '../../clock';
import { formatClockFromServiceSec } from '../../format';
import { ActionButton } from '../../primitives/ActionButton';
import { EmptyState } from '../../primitives/EmptyState';
import { TText } from '../../primitives/TText';
import { SPACING } from '../../tokens';
import { allowReminders } from '../notifications';
import { REMINDER_STATUS } from '../reminder-status';
import { tripWords } from '../trip-copy';
import { type ReminderDays, type TripDraft, tripOfDraft, type WalkChoice, walkIsFixed } from './add-trip';

/**
 * The add-trip flow's last step (M7.9): the trip's name (the two stations by default) and its "leave now"
 * reminders — none, weekdays or every day, at the usual departure time — then Save, which writes it
 * through the saved-trips repo (M7.3) and lands on the Trips tab, where its countdown starts. Reminders
 * are offered only with a fixed walk (a leave-by days ahead needs one); turning them on asks iOS for
 * notification permission.
 */

/** The usual departure starts at 8:00 AM and moves by a quarter hour a tap. */
export const DEFAULT_REMINDER_AT_MIN = 8 * 60;
const AT_STEP_MIN = 15;
const MINUTES_PER_DAY = 24 * 60;
const REMINDER_CHOICES: readonly { readonly days: ReminderDays; readonly label: string }[] = [
  { days: 'off', label: 'No reminders' },
  { days: 'weekdays', label: 'Weekdays' },
  { days: 'every-day', label: 'Every day' },
];
const TRIPS_TAB = '/trips';

export type ConfirmStepProps = { readonly from: string; readonly to: string; readonly walk: WalkChoice };

export function ConfirmStep({ from, to, walk }: ConfirmStepProps) {
  const user = useUserDb();
  const schedule = useScheduleDb();
  const names = schedule.kind === 'ready' ? new Map(schedule.repo.stations().map((s) => [s.stationKey, s.name] as const)) : null;
  const [name, setName] = useState(`${names?.get(from) ?? from} → ${names?.get(to) ?? to}`);
  const [days, setDays] = useState<ReminderDays>('off');
  const [atMin, setAtMin] = useState(DEFAULT_REMINDER_AT_MIN);
  const [problem, setProblem] = useState<string | null>(null);
  invariant(from !== to, 'a trip joins two stations');
  invariant(days === 'off' || walkIsFixed(walk), 'reminders are on only with a fixed walk');
  if (user.kind !== 'ready') {
    return <EmptyState testID="add-trip-no-db" title={tripWords.unavailable} message={user.kind === 'failed' ? user.message : 'Saved trips open with the app.'} />;
  }
  return (
    <ScrollView testID="add-trip-confirm" contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <TText variant="subhead" tone="secondary">
        Name
      </TText>
      <TextInput testID="trip-name" value={name} onChangeText={setName} maxLength={60} accessibilityLabel="Trip name" style={styles.input} />
      <ReminderChoice walk={walk} days={days} atMin={atMin} onDays={setDays} onAtMin={setAtMin} />
      <ActionButton testID="trip-save" symbol="checkmark" label={tripWords.saveTrip} hint="Saves the trip and shows its countdown" onPress={() => saveDraft(user.book, { id: randomUUID(), name: name.trim(), from, to, walk, reminderDays: days, reminderAtMin: atMin, createdEpoch: wallClockNowS() }, setProblem)} />
      {problem === null ? null : (
        <TText testID="trip-save-problem" variant="footnote" style={styles.problem}>
          {problem}
        </TText>
      )}
    </ScrollView>
  );
}

type ReminderChoiceProps = {
  readonly walk: WalkChoice;
  readonly days: ReminderDays;
  readonly atMin: number;
  readonly onDays: (days: ReminderDays) => void;
  readonly onAtMin: (update: (atMin: number) => number) => void;
};

/** Reminders: none, weekdays or every day, and the usual departure time — only with a fixed walk. */
function ReminderChoice({ walk, days, atMin, onDays, onAtMin }: ReminderChoiceProps) {
  invariant(atMin >= 0 && atMin < MINUTES_PER_DAY, 'the usual time is a time of day');
  invariant(days === 'off' || walkIsFixed(walk), 'reminders are chosen only with a fixed walk');
  if (!walkIsFixed(walk)) {
    return (
      <TText testID="reminders-need-walk" variant="footnote" tone="secondary">
        Reminders need a fixed walk (from here, or a number of minutes), so they are off for this trip.
      </TText>
    );
  }
  return (
    <View style={styles.reminders}>
      <TText variant="subhead" tone="secondary">
        Remind me to leave
      </TText>
      <View style={styles.row}>
        {REMINDER_CHOICES.map((choice) => (
          <ActionButton key={choice.days} testID={`reminders-${choice.days}`} symbol={choice.days === days ? 'checkmark.circle.fill' : 'circle'} label={choice.label} hint="Chooses the days of the reminders" onPress={() => onDays(choice.days)} />
        ))}
      </View>
      {days === 'off' ? null : (
        <View style={styles.row}>
          <ActionButton testID="reminder-earlier" symbol="minus" label="Earlier" hint="A quarter hour earlier" onPress={() => onAtMin((m) => (m + MINUTES_PER_DAY - AT_STEP_MIN) % MINUTES_PER_DAY)} />
          <TText testID="reminder-at" variant="title">{`Trains from ${formatClockFromServiceSec(atMin * 60)}`}</TText>
          <ActionButton testID="reminder-later" symbol="plus" label="Later" hint="A quarter hour later" onPress={() => onAtMin((m) => (m + AT_STEP_MIN) % MINUTES_PER_DAY)} />
        </View>
      )}
    </View>
  );
}

/** Saves the draft; on success asks for notification permission when it has reminders, then shows the Trips tab. */
export function saveDraft(book: TripBook, draft: TripDraft, report: (problem: string | null) => void): Result<unknown, SavedTripError> {
  invariant(typeof book.save === 'function', 'the trips are written through the user DB');
  const saved = book.save(tripOfDraft(draft));
  report(saved.ok ? null : saved.error.message);
  if (saved.ok && draft.reminderDays !== 'off') {
    detach(
      allowReminders().then((allowed) => (allowed.ok ? undefined : REMINDER_STATUS.report(allowed.error))),
      (message) => REMINDER_STATUS.report(`Notification permission could not be asked: ${message}`),
    );
  }
  if (saved.ok) {
    router.navigate(TRIPS_TAB);
  }
  invariant(saved.ok || saved.error.message.length > 0, 'a refused trip says why');
  return saved;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  input: { minHeight: 44, paddingHorizontal: SPACING.md, borderRadius: 12, fontSize: 17, color: PlatformColor('label'), backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  reminders: { gap: SPACING.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs },
  problem: { color: PlatformColor('systemRed') },
});
