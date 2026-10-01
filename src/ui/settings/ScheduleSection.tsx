import { Text } from 'react-native';

import scheduleManifest from '@/assets/db/manifest.json';
import { invariant } from '@/lib/invariant';
import { shortFeedHash, shortServiceDate } from '@/ui/diagnostics/data-version';

import { expiryText } from './settings-text';
import { SettingsRow, SettingsSection, settingsStyles as styles } from './SettingsSection';

/**
 * Plan M8b.1 "Schedule": the bundled schedule's feed hash, the last service date of rail and of the
 * Mover (the county publishes them with different ends), and the expiry state of the one that runs
 * out first (M3.7: ok > 14 days, warn ≤ 14, urgent ≤ 3, expired).
 */
export function ScheduleSection({ nowS }: { readonly nowS: number }) {
  const { feedSha256, serviceEnd } = scheduleManifest;
  const expiry = expiryText(nowS);
  invariant(serviceEnd.rail.date > 0 && serviceEnd.mover.date > 0, 'the manifest records a service end for both modes');
  invariant(expiry.text.length > 0, 'the expiry state always reads as something');
  const tone = expiry.state === 'ok' ? null : expiry.state === 'warn' ? styles.warning : styles.error;
  return (
    <SettingsSection title="Schedule" footer="Bundled with the app from the county's GTFS feed (Miami-Dade DTPW).">
      <SettingsRow label="Feed" value={shortFeedHash(feedSha256)} testID="schedule-feed" />
      <SettingsRow label="Rail service through" value={shortServiceDate(serviceEnd.rail.date)} testID="schedule-rail-end" />
      <SettingsRow label="Mover service through" value={shortServiceDate(serviceEnd.mover.date)} testID="schedule-mover-end" />
      <Text testID="schedule-expiry" style={[styles.detail, tone]}>
        {expiry.text}
      </Text>
    </SettingsSection>
  );
}
