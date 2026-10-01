import { useCallback, useState } from 'react';
import { PlatformColor, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { invariant } from '@/lib/invariant';
import { err } from '@/lib/result';

import { PROBES, type ProbeSpec } from './probe-catalog';
import type { ProbeOutcome } from './probe-kit';

type RowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly outcome: ProbeOutcome };

const IDLE: RowState = { kind: 'idle' };
const RUNNING: RowState = { kind: 'running' };
const IN_APP_PROBES = PROBES.filter((spec) => !spec.leavesApp);
const PROBE_IDS: ReadonlySet<string> = new Set(PROBES.map((spec) => spec.id));

/**
 * The M1 Diagnostics screen: every capability probe as a row Jamie runs on the phone (M1.19).
 * Tap a row to run that probe; "Run all" runs the in-app probes one at a time (so permission
 * prompts never stack) and leaves the maps:// probe, which switches apps, to its own tap.
 */
export function DiagnosticsScreen() {
  invariant(PROBES.length === 9, 'the screen lists the nine M1 probes');
  invariant(PROBE_IDS.size === PROBES.length, 'probe ids are unique');
  const { states, busy, runOne, runAll } = useProbeRunner();
  const passed = PROBES.filter((spec) => isPass(states[spec.id])).length;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Plan M1.19: run every probe on the phone. For the notification, keep this screen open until it reports (about 5 s).
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => {
          void runAll();
        }}
        style={styles.runAll}>
        <Text style={styles.runAllText}>{busy ? 'Running…' : `Run all (${IN_APP_PROBES.length} in-app probes)`}</Text>
      </Pressable>
      <Text style={styles.summary}>{`${passed} of ${PROBES.length} passed`}</Text>
      {PROBES.map((spec) => (
        <ProbeRow key={spec.id} spec={spec} state={states[spec.id] ?? IDLE} disabled={busy} onRun={runOne} />
      ))}
    </ScrollView>
  );
}

/** Probe state per row. A probe never rejects (settleProbe), and if one ever did it would show as FAIL. */
function useProbeRunner() {
  const [states, setStates] = useState<Readonly<Record<string, RowState>>>({});
  const [busy, setBusy] = useState(false);
  invariant(Object.keys(states).every((id) => PROBE_IDS.has(id)), 'state is kept only for listed probes');
  const runOne = useCallback(async (spec: ProbeSpec): Promise<void> => {
    setStates((prev) => ({ ...prev, [spec.id]: RUNNING }));
    const outcome = await spec.run().catch((error: unknown) => err(`${spec.title}: ${String(error)}`));
    setStates((prev) => ({ ...prev, [spec.id]: { kind: 'done', outcome } }));
  }, []);
  const runAll = useCallback(async (): Promise<void> => {
    setBusy(true);
    await runSequentially(IN_APP_PROBES, runOne);
    setBusy(false);
  }, [runOne]);
  invariant(IN_APP_PROBES.length > 0 && IN_APP_PROBES.length < PROBES.length, '"Run all" skips only the app-leaving probes');
  return { states, busy, runOne, runAll };
}

/** One probe after another — concurrent permission prompts would stack and time each other out. */
async function runSequentially(specs: readonly ProbeSpec[], run: (spec: ProbeSpec) => Promise<void>): Promise<void> {
  invariant(specs.length > 0, 'there is at least one probe to run');
  invariant(specs.every((spec) => !spec.leavesApp), '"Run all" never leaves the app');
  for (const spec of specs) {
    await run(spec);
  }
}

function isPass(state: RowState | undefined): boolean {
  invariant(state === undefined || ['idle', 'running', 'done'].includes(state.kind), 'a row state has a known kind');
  const pass = state?.kind === 'done' && state.outcome.ok;
  invariant(typeof pass === 'boolean', 'a row either passed or did not');
  return pass;
}

type ProbeRowProps = {
  readonly spec: ProbeSpec;
  readonly state: RowState;
  readonly disabled: boolean;
  readonly onRun: (spec: ProbeSpec) => Promise<void>;
};

function ProbeRow({ spec, state, disabled, onRun }: ProbeRowProps) {
  invariant(spec.title.length > 0 && spec.expectation.length > 0, 'every row says what it checks');
  invariant(state.kind !== 'done' || typeof state.outcome.ok === 'boolean', 'a finished row holds a Result');
  const verdict = rowVerdict(state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${spec.title}: ${verdict.label}. ${verdict.detail}`}
      disabled={disabled || state.kind === 'running'}
      onPress={() => {
        void onRun(spec);
      }}
      style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>{spec.title}</Text>
        <Text style={[styles.verdict, { color: verdict.color }]}>{verdict.label}</Text>
      </View>
      <Text style={styles.expectation}>{spec.expectation}</Text>
      {verdict.detail.length > 0 ? <Text style={styles.detail}>{verdict.detail}</Text> : null}
    </Pressable>
  );
}

type Verdict = { readonly label: string; readonly detail: string; readonly color: ReturnType<typeof PlatformColor> };

function rowVerdict(state: RowState): Verdict {
  invariant(['idle', 'running', 'done'].includes(state.kind), 'a row state has a known kind');
  let verdict: Verdict;
  switch (state.kind) {
    case 'idle':
      verdict = { label: 'Tap to run', detail: '', color: PlatformColor('secondaryLabel') };
      break;
    case 'running':
      verdict = { label: 'Running…', detail: '', color: PlatformColor('secondaryLabel') };
      break;
    case 'done':
      verdict = state.outcome.ok
        ? { label: 'PASS', detail: state.outcome.value, color: PlatformColor('systemGreen') }
        : { label: 'FAIL', detail: state.outcome.error, color: PlatformColor('systemRed') };
      break;
  }
  invariant(verdict.label.length > 0, 'every row shows a verdict');
  return verdict;
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  intro: { fontSize: 15, color: PlatformColor('secondaryLabel') },
  runAll: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', backgroundColor: PlatformColor('systemBlue') },
  runAllText: { fontSize: 17, fontWeight: '600', color: 'white' },
  summary: { fontSize: 15, fontVariant: ['tabular-nums'], color: PlatformColor('label') },
  row: { borderRadius: 12, padding: 12, gap: 4, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  rowTitle: { fontSize: 17, fontWeight: '600', color: PlatformColor('label') },
  verdict: { fontSize: 15, fontWeight: '700' },
  expectation: { fontSize: 13, color: PlatformColor('secondaryLabel') },
  detail: { fontSize: 13, fontVariant: ['tabular-nums'], color: PlatformColor('label') },
});
