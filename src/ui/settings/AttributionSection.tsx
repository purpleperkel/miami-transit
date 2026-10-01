import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { type Notice, openLinkNotice, runAction } from './settings-actions';
import { NoticeText, SettingsSection, settingsStyles as styles } from './SettingsSection';

/**
 * Plan M8b.1 "Attribution": every source the app shows data from, with the two links the plan names
 * — Transitland's terms and Transitous's sources page. Links open in Safari (settings-actions.ts).
 */

type SourceLinkSpec = { readonly testID: string; readonly url: string; readonly label: string };
type Source = { readonly name: string; readonly gives: string; readonly link: SourceLinkSpec | null };

export const ATTRIBUTION_SOURCES: readonly Source[] = Object.freeze([
  { name: 'Miami-Dade DTPW', gives: 'Metrorail and Metromover schedules (GTFS), Department of Transportation and Public Works', link: null },
  { name: 'Swiftly', gives: 'Live vehicles and predictions, when a Swiftly key is saved', link: null },
  {
    name: 'Transitland',
    gives: 'Live vehicles and departures (Interline)',
    link: { testID: 'attribution-link-transitland', url: 'https://www.transit.land/terms', label: 'transit.land/terms' },
  },
  {
    name: 'Transitous',
    gives: 'Route options, built on © OpenStreetMap contributors',
    link: { testID: 'attribution-link-transitous', url: 'https://transitous.org/sources', label: 'transitous.org/sources' },
  },
]);

export function AttributionSection() {
  const [notice, setNotice] = useState<Notice | null>(null);
  invariant(ATTRIBUTION_SOURCES.length === 4, 'the plan names four sources');
  invariant(new Set(ATTRIBUTION_SOURCES.map((source) => source.name)).size === ATTRIBUTION_SOURCES.length, 'each source is credited once');
  return (
    <SettingsSection title="Attribution">
      {ATTRIBUTION_SOURCES.map((source) => (
        <SourceRow key={source.name} source={source} onNotice={setNotice} />
      ))}
      <NoticeText notice={notice} testID="attribution-notice" />
    </SettingsSection>
  );
}

/** One credited source: its name, what it gives the app, and its link if the plan names one. */
function SourceRow({ source, onNotice }: { readonly source: Source; readonly onNotice: (notice: Notice | null) => void }) {
  invariant(source.name.length > 0 && source.gives.length > 0, 'a credit names the source and what it gives');
  invariant(typeof onNotice === 'function', 'a link that cannot open says so');
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>{source.name}</Text>
      <Text style={styles.detail}>{source.gives}</Text>
      {source.link === null ? null : <SourceLink link={source.link} onNotice={onNotice} />}
    </View>
  );
}

/** A source's link, opened in Safari; a link that cannot open says so in the section's notice. */
function SourceLink({ link, onNotice }: { readonly link: SourceLinkSpec; readonly onNotice: (notice: Notice | null) => void }) {
  invariant(link.url.startsWith('https://'), 'attribution links are https');
  invariant(link.testID.startsWith('attribution-link-'), 'an attribution link is findable by its testID');
  return (
    <Pressable testID={link.testID} accessibilityRole="link" accessibilityHint={link.url} onPress={() => runAction(openLinkNotice(link.url), onNotice)}>
      <Text style={styles.link}>{link.label}</Text>
    </Pressable>
  );
}
