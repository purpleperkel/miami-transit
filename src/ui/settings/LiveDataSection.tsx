import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { DEFAULT_SWIFTLY_AGENCY_KEY } from '@/domain/live/transports';
import { PROVIDER_IDS, type ProviderId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import type { LiveContextValue } from '@/live/live-context';

import { type HealthKind, providerHealth } from './provider-health';
import { confirmClearKey, type Notice, runAction, saveAgencyNotice, saveKeyNotice } from './settings-actions';
import { keyStatusText, PROVIDER_NAMES, quotaText } from './settings-text';
import { NoticeText, SettingsSection, settingsStyles as styles } from './SettingsSection';

/**
 * Plan M8b.1 "Live data": per provider, the key ("Saved ••••<last4>" or "Not set"), a paste field with
 * Save, Remove, the provider's health (live / failing / stale, update age, bytes per poll) and its
 * monthly calls against its quota; Swiftly also has its agency key. Everything is read from the live
 * state; every change goes through the live runtime (settings-actions.ts).
 */
export function LiveDataSection({ live, nowS }: { readonly live: LiveContextValue; readonly nowS: number }) {
  invariant(live.state === null || live.runtime !== null, 'a published state belongs to a runtime');
  invariant(Number.isFinite(nowS), 'the section is drawn at an instant');
  return (
    <SettingsSection title="Live data" footer="Keys stay in this phone's Keychain. Swiftly serves first when it has a key; Transitland otherwise.">
      {PROVIDER_IDS.map((provider) => (
        <ProviderCard key={provider} provider={provider} live={live} nowS={nowS} />
      ))}
    </SettingsSection>
  );
}

const HEALTH_TONE: Readonly<Record<HealthKind, 'ok' | 'error' | 'warning' | null>> = Object.freeze({
  starting: null,
  off: null,
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
