import { useIsFocused } from 'expo-router';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

import type { TimetableOutcome } from '@/data/schedule-repo';
import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import { detach } from '@/live/detach';

import { tickPlan } from './tickPlan';
import { recordTickTime } from './tickTime';
import { type FramePlan, framesAt, NO_SHOWN, planFrames, SAMPLE_S, type ShownTracks, type VehicleFrame } from './vehicleFrames';

/**
 * The map's vehicles, frame by frame (plan M5.10). A timer ticks at the tick plan's period (250 ms
 * focused, 5 s under Reduce Motion, none when the map is out of sight) and each tick draws every
 * vehicle at that instant (vehicleFrames.ts framesAt — pure, no SQL). The timetable is read once per
 * SAMPLE_S span, or when a new live batch arrives (ScheduleRepo.timetableAround), never per frame.
 * Each tick's draw is timed and recorded for Diagnostics (tickTime.ts, the M5.13 "tick time" check).
 */

/** What the frames read the timetable from: the schedule repo (tests pass a counting fake). */
export type TimetableSource = { timetableAround(fromEpoch: number, toEpoch: number): TimetableOutcome };

export type VehicleFrames = {
  readonly vehicles: readonly VehicleFrame[];
  /** The instant (epoch s) the frame was drawn for, or null before the first one. */
  readonly atS: number | null;
};

const NO_FRAMES: VehicleFrames = Object.freeze({ vehicles: [], atS: null });

type PlanHolder = { plan: FramePlan | null; source: TimetableSource | null; shown: ShownTracks };

/**
 * Every vehicle at the latest frame tick. `tickMs` 0 draws one frame and starts no timer. `source`,
 * `batch` and `clockMs` must keep their identity between renders (a new one restarts the timer).
 */
export function useVehicleFrames(
  source: TimetableSource | null,
  batch: LiveBatch<LiveVehicle> | null,
  tickMs: number,
  clockMs: () => number = Date.now,
): VehicleFrames {
  invariant(Number.isFinite(tickMs) && tickMs >= 0, `a tick period is a non-negative number of ms, got ${tickMs}`);
  invariant(typeof clockMs === 'function', 'frames are drawn against a clock');
  const holder = useRef<PlanHolder>({ plan: null, source: null, shown: NO_SHOWN });
  const [frames, setFrames] = useState<VehicleFrames>(NO_FRAMES);
  useEffect(() => runFrames(() => setFrames(timedFrames(holder, source, batch, clockMs() / 1000)), tickMs), [source, batch, tickMs, clockMs]);
  return frames;
}

/** Draws one frame now, then one every `tickMs` (none for 0); returns the teardown. */
function runFrames(draw: () => void, tickMs: number): () => void {
  invariant(typeof draw === 'function', 'a frame timer draws frames');
  invariant(tickMs >= 0, 'a tick period is never negative');
  draw();
  const timer = tickMs === 0 ? null : setInterval(draw, tickMs);
  return () => {
    if (timer !== null) {
      clearInterval(timer);
    }
  };
}

/** One frame at `nowS` (nextFrames), its draw timed with performance.now() and recorded for Diagnostics. */
function timedFrames(holder: RefObject<PlanHolder>, source: TimetableSource | null, batch: LiveBatch<LiveVehicle> | null, nowS: number): VehicleFrames {
  const startMs = performance.now();
  invariant(Number.isFinite(startMs), 'the frame timer reads a monotonic clock');
  const frames = nextFrames(holder, source, batch, nowS);
  const durationMs = performance.now() - startMs;
  invariant(durationMs >= 0, 'a monotonic clock never runs backward');
  recordTickTime(durationMs);
  return frames;
}

/** One frame at `nowS`: the plan is remade when its span has passed, or the timetable or the live batch changed. */
function nextFrames(holder: RefObject<PlanHolder>, source: TimetableSource | null, batch: LiveBatch<LiveVehicle> | null, nowS: number): VehicleFrames {
  invariant(Number.isFinite(nowS), 'a frame is drawn at an instant');
  const held = holder.current;
  if (held.plan === null || held.source !== source || held.plan.batch !== batch || nowS < held.plan.fromS || nowS > held.plan.toS) {
    held.plan = makePlan(source, batch, Math.floor(nowS));
    held.source = source;
  }
  const drawn = framesAt(held.plan, nowS, held.shown);
  held.shown = drawn.shown;
  invariant(held.plan.fromS <= nowS && nowS <= held.plan.toS, 'the frame falls inside its plan');
  return { vehicles: drawn.frames, atS: nowS };
}

/** The plan for [fromS, fromS + SAMPLE_S]: the one timetable read of the span, then the merge. */
function makePlan(source: TimetableSource | null, batch: LiveBatch<LiveVehicle> | null, fromS: number): FramePlan {
  invariant(Number.isSafeInteger(fromS), 'a sample starts on a whole second');
  const outcome = source === null ? null : source.timetableAround(fromS, fromS + SAMPLE_S);
  const plan = planFrames(outcome !== null && outcome.kind === 'timetable' ? { days: outcome.days, shapes: outcome.shapes } : null, batch, fromS);
  invariant(plan.fromS === fromS && plan.toS === fromS + SAMPLE_S, 'the plan covers one sample span');
  return plan;
}

/** The Map tab's motion now: its frame tick period (tickPlan) and whether Reduce Motion is on. */
export type FrameTick = { readonly tickMs: number; readonly reduceMotion: boolean };

/** The frame tick for the Map tab now: the app's state, the tab's focus and Reduce Motion, through tickPlan. */
export function useFrameTick(): FrameTick {
  const mapFocused = useIsFocused();
  const appActive = useAppActive();
  const reduceMotion = useReduceMotion();
  invariant(typeof mapFocused === 'boolean', 'the Map tab is focused or not');
  const tickMs = tickPlan({ appActive, mapFocused, reduceMotion });
  invariant(tickMs >= 0, 'a tick period is never negative');
  return { tickMs, reduceMotion };
}

/** Whether the app is in the foreground (AppState 'active'), following every change. */
function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  invariant(typeof AppState.addEventListener === 'function', 'React Native provides AppState');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  invariant(typeof active === 'boolean', 'the app is active or not');
  return active;
}

/**
 * iOS Reduce Motion, following every change. The first read is a promise; it cannot fail on iOS, so
 * a rejection is a bug, raised through React (an updater that throws) rather than lost.
 */
function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  invariant(typeof AccessibilityInfo.isReduceMotionEnabled === 'function', 'React Native reads Reduce Motion');
  useEffect(() => followReduceMotion(setReduceMotion), []);
  invariant(typeof reduceMotion === 'boolean', 'Reduce Motion is on or off');
  return reduceMotion;
}

/** Reads Reduce Motion now and on every change into `set`; returns the teardown. */
function followReduceMotion(set: Dispatch<SetStateAction<boolean>>): () => void {
  invariant(typeof set === 'function', 'Reduce Motion is reported to a state setter');
  const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', set);
  invariant(typeof subscription.remove === 'function', 'the Reduce Motion listener can be removed');
  detach(AccessibilityInfo.isReduceMotionEnabled().then(set), (message) =>
    set(() => {
      throw new Error(`reading Reduce Motion failed: ${message}`);
    }),
  );
  return () => subscription.remove();
}
