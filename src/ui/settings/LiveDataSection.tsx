import { useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { DEFAULT_SWIFTLY_AGENCY_KEY } from '@/domain/live/transports';
import { PROVIDER_IDS, type ProviderId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import type { LiveContextValue } from '@/live/live-context';
import { readSwiftlyWifiOnly, saveSwiftlyWifiOnly } from '@/live/swiftly-wifi';

import { type HealthKind, providerHealth } from './provider-health';
import { confirmClearKey, type Notice, runAction, saveAgencyNotice, saveKeyNotice } from './settings-actions';
import { keyStatusText, PROVIDER_NAMES, quotaText } from './settings-text';
import { NoticeText, SettingsSection, settingsStyles as styles } from './SettingsSection';

/**
 * Plan M8b.1 "Live data": per provider, the key ("Saved ••••<last4>" or "Not set"), a paste field with
 * Save, Remove, the provider's health (live / failing / stale, update age, bytes per poll) and its
 * monthly calls against its quota; Swiftly also has its agency key and the "Use Swiftly only on Wi-Fi"
 * switch (mfix10). Everything is read from the live state; every key change goes through the live
 * runtime (settings-actions.ts), and the switch saves the runtime's own setting (src/live/swiftly-wifi.ts).
 */
export function LiveDataSection({ live, nowS }: { readonly live: LiveContextValue; readonly nowS: number }) {
  invariant(live.state === null || live.runtime !== null, 'a published state belongs to a runtime');
  invariant(Number.isFinite(nowS), 'the section is drawn at an instant');
  return (
    <SettingsSection title="Live data" footer={LIVE_DATA_FOOTER}>
      {PROVIDER_IDS.map((provider) => (
        <ProviderCard key={provider} provider={provider} live={live} nowS={nowS} />
      ))}
    </SettingsSection>
  );
}

/** Who serves, and the Wi-Fi rule (mfix10). */
const LIVE_DATA_FOOTER = "Keys stay in this phone's Keychain. Swiftly serves first when it has a key (only on Wi-Fi, if that is on); Transitland otherwise.";

/** The Wi-Fi only switch's words: shown beside it and read by VoiceOver. */
const WIFI_ONLY_LABEL = 'Use Swiftly only on Wi-Fi';

const HEALTH_TONE: Readonly<Record<HealthKind, 'ok' | 'error' | 'warning' | null>> = Object.freeze({
  starting: null,
  off: null,
  gated: null,
  paused: 'warning',
  failing: 'error',
  standby: null,
  waiting: null,
  live: 'ok',
  stale: 'warning',
});

function ProviderCard({ provider, live, nowS }: { readonly provider: ProviderId; readonly live: LiveContextValue; readonly nowS: number }) {
  const health = providerHealth(live.state, provider, nowS);
  const calls = live.state === null ? null : live.state.callsThisMonth[provider];
  const tone = HEALTH_TONE[health.kind];
  invariant(health.text.length > 0, 'the status row says something');
  invariant(calls === null || calls >= 0, 'a call count is never negative');
  return (
    <View style={styles.stack}>
      <Text accessibilityRole="header" style={styles.heading}>
        {PROVIDER_NAMES[provider]}
      </Text>
      <KeyEditor provider={provider} live={live} />
      {provider === 'swiftly' ? <AgencyEditor live={live} /> : null}
      {provider === 'swiftly' ? <WifiOnlySwitch /> : null}
      <Text testID={`provider-status-${provider}`} style={[styles.detail, tone === null ? null : styles[tone]]}>
        {health.text}
      </Text>
      <Text testID={`provider-quota-${provider}`} style={styles.detail}>
        {calls === null ? 'Calls this month: …' : quotaText(provider, calls)}
      </Text>
    </View>
  );
}

/** The key row: its masked status, a paste field that clears after every Save, and Remove once a key is stored. */
function KeyEditor({ provider, live }: { readonly provider: ProviderId; readonly live: LiveContextValue }) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const { runtime, state } = live;
  const hasKey = state !== null && state.hasKey[provider];
  const canSave = runtime !== null && draft.trim() !== '';
  invariant(!hasKey || state?.keyHints[provider] !== null, 'a stored key has a masked hint');
  invariant(provider in PROVIDER_NAMES, `"${provider}" is a realtime provider`);
  return (
    <View style={styles.stack}>
      <Text testID={`key-status-${provider}`} style={styles.detail}>
        {keyStatusText(state, provider)}
      </Text>
      <View style={styles.controls}>
        <TextInput
          testID={`key-input-${provider}`}
          accessibilityLabel={`${PROVIDER_NAMES[provider]} API key`}
          value={draft}
          onChangeText={setDraft}
          placeholder={hasKey ? 'Paste a new key to replace it' : 'Paste the API key'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          style={styles.input}
        />
        <Pressable
          testID={`key-save-${provider}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={() => {
            setDraft('');
            runAction(saveKeyNotice(runtime, provider, draft), setNotice);
          }}
          style={[styles.button, canSave ? null : styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
      {hasKey ? (
        <Pressable testID={`key-clear-${provider}`} accessibilityRole="button" onPress={() => confirmClearKey(runtime, provider, setNotice)}>
          <Text style={styles.destructiveText}>Remove key</Text>
        </Pressable>
      ) : null}
      <NoticeText notice={notice} testID={`key-notice-${provider}`} />
    </View>
  );
}

/**
 * "Use Swiftly only on Wi-Fi" (mfix10, ON by default): the switch shows the setting in effect and saves
 * each toggle in its kv item. The live runtime reads the setting at every poll tick, so a toggle moves
 * Swiftly in or out of the chain within one cadence; a save the kv store refuses says so and the switch
 * goes back to the setting in effect.
 */
function WifiOnlySwitch() {
  const [wifiOnly, setWifiOnly] = useState(() => readSwiftlyWifiOnly());
  const [notice, setNotice] = useState<Notice | null>(null);
  invariant(typeof wifiOnly === 'boolean', 'the switch is on or off');
  invariant(notice === null || notice.tone === 'error', 'the switch speaks up only when a save fails');
  const onValueChange = (value: boolean) => {
    const saved = saveSwiftlyWifiOnly(value);
    invariant(!saved.ok || saved.value === value, 'a saved setting reads back as toggled');
    invariant(saved.ok || saved.error.message.length > 0, 'a refused save explains itself');
    setWifiOnly(saved.ok ? saved.value : readSwiftlyWifiOnly());
    setNotice(saved.ok ? null : { tone: 'error', text: `Not saved: ${saved.error.message}.` });
  };
  return (
    <View style={styles.stack}>
      <View style={styles.controls}>
        <Text style={[styles.label, styles.grow]}>{WIFI_ONLY_LABEL}</Text>
        <Switch testID="swiftly-wifi-only" accessibilityLabel={WIFI_ONLY_LABEL} value={wifiOnly} onValueChange={onValueChange} />
      </View>
      <NoticeText notice={notice} testID="swiftly-wifi-only-notice" />
    </View>
  );
}

/** Swiftly's agency key (its URLs' path segment, from the same onboarding email as the key): the one in effect, editable. */
function AgencyEditor({ live }: { readonly live: LiveContextValue }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const value = draft ?? live.state?.swiftlyAgency ?? DEFAULT_SWIFTLY_AGENCY_KEY;
  invariant(typeof value === 'string', 'the field always shows an agency key or an edit of one');
  invariant(live.state === null || live.state.swiftlyAgency.length > 0, 'the agency key in effect is never blank');
  return (
    <View style={styles.stack}>
      <Text style={styles.detail}>Agency key (blank restores {DEFAULT_SWIFTLY_AGENCY_KEY})</Text>
      <View style={styles.controls}>
        <TextInput
          testID="agency-input-swiftly"
          accessibilityLabel="Swiftly agency key"
          value={value}
          onChangeText={setDraft}
          placeholder={DEFAULT_SWIFTLY_AGENCY_KEY}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Pressable
          testID="agency-save-swiftly"
          accessibilityRole="button"
          onPress={() => {
            setDraft(null);
            runAction(saveAgencyNotice(live.runtime, value), setNotice);
          }}
          style={styles.button}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
      <NoticeText notice={notice} testID="agency-notice-swiftly" />
    </View>
  );
}
