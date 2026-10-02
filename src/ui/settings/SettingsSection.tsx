import type { ReactNode } from 'react';
import { PlatformColor, StyleSheet, Text, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import type { Notice } from './settings-actions';

/** One grouped section of Data & Settings: a header, a card of rows, and an optional footnote. */
export function SettingsSection({ title, footer, children }: { readonly title: string; readonly footer?: string; readonly children: ReactNode }) {
  invariant(title.length > 0, 'a section has a title');
  invariant(footer === undefined || footer.length > 0, 'a footnote says something');
  return (
    <View style={settingsStyles.section}>
      <Text accessibilityRole="header" style={settingsStyles.sectionTitle}>
        {title}
      </Text>
      <View style={settingsStyles.card}>{children}</View>
      {footer === undefined ? null : <Text style={settingsStyles.footer}>{footer}</Text>}
    </View>
  );
}

/** A label on the left, its value on the right. */
export function SettingsRow({ label, value, testID }: { readonly label: string; readonly value: string; readonly testID?: string }) {
  invariant(label.length > 0, 'a row has a label');
  invariant(value.length > 0, 'a row has a value');
  return (
    <View style={settingsStyles.row}>
      <Text style={settingsStyles.label}>{label}</Text>
      <Text testID={testID} style={settingsStyles.value}>
        {value}
      </Text>
    </View>
  );
}

/** What an action just did (saved, refused, failed), under the control that did it; nothing before any action. */
export function NoticeText({ notice, testID }: { readonly notice: Notice | null; readonly testID: string }) {
  invariant(testID.length > 0, 'a notice is findable by its testID');
  invariant(notice === null || notice.text.length > 0, 'a notice says something');
  if (notice === null) {
    return null;
  }
  return (
    <Text testID={testID} accessibilityLiveRegion="polite" style={[settingsStyles.notice, notice.tone === 'ok' ? settingsStyles.ok : settingsStyles.error]}>
      {notice.text}
    </Text>
  );
}

export const settingsStyles = StyleSheet.create({
  section: { gap: 6 },
  stack: { gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', color: PlatformColor('secondaryLabel'), paddingHorizontal: 16 },
  card: { borderRadius: 12, padding: 12, gap: 10, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  footer: { fontSize: 13, color: PlatformColor('secondaryLabel'), paddingHorizontal: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  label: { fontSize: 17, color: PlatformColor('label') },
  value: { fontSize: 17, fontVariant: ['tabular-nums'], color: PlatformColor('secondaryLabel'), flexShrink: 1, textAlign: 'right' },
  heading: { fontSize: 17, fontWeight: '600', color: PlatformColor('label') },
  detail: { fontSize: 15, color: PlatformColor('secondaryLabel') },
  input: {
    flex: 1,
    fontSize: 17,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    color: PlatformColor('label'),
    backgroundColor: PlatformColor('tertiarySystemGroupedBackground'),
  },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: PlatformColor('systemBlue') },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 17, fontWeight: '600', color: 'white' },
  destructiveText: { fontSize: 17, color: PlatformColor('systemRed') },
  link: { fontSize: 17, color: PlatformColor('link') },
  notice: { fontSize: 15 },
  ok: { color: PlatformColor('systemGreen') },
  error: { color: PlatformColor('systemRed') },
  warning: { color: PlatformColor('systemOrange') },
});
