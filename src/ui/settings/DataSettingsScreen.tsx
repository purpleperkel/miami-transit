import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { PlatformColor, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { HEARTBEAT_MS } from '@/domain/live/constants';
import { invariant } from '@/lib/invariant';
import { type LiveContextValue, useLive } from '@/live/live-context';
import { wallClockS } from '@/live/runtime';

import { AttributionSection } from './AttributionSection';
import { LiveDataSection } from './LiveDataSection';
import { ScheduleSection } from './ScheduleSection';
import { SettingsSection, settingsStyles } from './SettingsSection';
import { WalkingPaceSection } from './WalkingPaceSection';

/**
 * Plan M8b.1: Data & Settings (route /data, opened from the tab bar's accessory, the status pill and
 * Diagnostics). The route renders DataSettingsScreen, which reads the live context; everything below
 * it is DataSettingsView, driven by props alone (no navigation hooks), so it renders the same in a
 * test as on the phone.
 */
export function DataSettingsScreen() {
  const live = useLive();
  invariant(live.state === null || live.runtime !== null, 'a published state belongs to a runtime');
  invariant(typeof DataSettingsView === 'function', 'the screen renders the view');
  return <DataSettingsView live={live} />;
}

export type DataSettingsViewProps = {
  readonly live: LiveContextValue;
  /** The clock in epoch seconds (the wall clock; tests pass a fixed one). */
  readonly clock?: () => number;
};

export function DataSettingsView({ live, clock = wallClockS }: DataSettingsViewProps) {
  const nowS = useNowS(clock);
  invariant(live.state === null || live.runtime !== null, 'a published state belongs to a runtime');
  invariant(Number.isFinite(nowS), 'the screen is drawn at an instant');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.content}>
      <LiveDataSection live={live} nowS={nowS} />
      <ScheduleSection nowS={nowS} />
      <WalkingPaceSection />
      <AttributionSection />
      <SettingsSection title="Diagnostics" footer="Capability probes for this phone (location, notifications, the bundled database…).">
        <Pressable testID="diagnostics-link" accessibilityRole="link" onPress={() => router.push('/diagnostics')}>
          <Text style={settingsStyles.link}>Open Diagnostics</Text>
        </Pressable>
      </SettingsSection>
    </ScrollView>
  );
}

/** `clock()`, read again every heartbeat while the screen is open, so ages ("updated 12 s ago") keep counting between polls. */
function useNowS(clock: () => number): number {
  const [nowS, setNowS] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNowS(clock()), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [clock]);
  invariant(typeof clock === 'function', 'the screen reads a clock');
  invariant(Number.isFinite(nowS), 'the clock reads a finite instant');
  return nowS;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: 16, gap: 24 },
});
