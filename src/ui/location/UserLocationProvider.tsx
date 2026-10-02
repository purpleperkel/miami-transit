import * as Location from 'expo-location';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { invariant } from '@/lib/invariant';
import { detach } from '@/live/detach';
import {
  askForLocation,
  fixed,
  LocationContext,
  LOCATING,
  positionOf,
  type SharedLocation,
  takenAtOf,
  unlocated,
  type UserLocation,
  type UserPosition,
  WATCH_DISTANCE_M,
} from '@/ui/map/use-user-location';

/**
 * mfix6: the app's ONE location owner. The root layout (src/app/_layout.tsx) mounts it once, around the
 * root Stack, so every screen sits under it. On mount it asks for foreground location ONCE and, granted,
 * runs the app's ONE expo-location watch (Balanced accuracy, a new fix every WATCH_DISTANCE_M). The answer
 * and the latest fix reach every reader through LocationContext (use-user-location.ts): the map's blue dot
 * (useUserLocation), and the Stations list, the hurry hook and the Now strip, the Trips tab, a trip's
 * screen and the route options sheet (useUserPosition). Before this, each of those opened a watch of its
 * own: the real app ran 4 and asked 5 times, the Now strip being mounted twice on iOS 26 (one per accessory
 * placement). Anything but an explicit grant is denied (use-user-location.ts): no watch, no fix, a note.
 *
 * This is the only module that calls watchPositionAsync, and only the root layout mounts it.
 */

type Unwatch = { remove(): void };
/** The provider's watch: whether the provider has gone, whether the ask has answered, and the expo-location subscription once it starts. */
type Watch = { stopped: boolean; answered: boolean; subscription: Unwatch | null };
/** Where the ask and the watch report: the permission answer, and each fix (or why there is none). */
type Report = {
  readonly answer: (location: UserLocation) => void;
  readonly publish: (position: UserPosition) => void;
};

export function UserLocationProvider({ children }: { readonly children?: ReactNode }) {
  const [location, setLocation] = useState<UserLocation>(LOCATING.location);
  const [position, setPosition] = useState<UserPosition>(LOCATING.position);
  useEffect(() => startWatch({ answer: setLocation, publish: setPosition }), []);
  const shared = useMemo<SharedLocation>(() => ({ location, position }), [location, position]);
  invariant(position.coordinate === null || location.kind === 'granted', 'a fix arrives only with a grant');
  invariant(shared.location === location && shared.position === position, 'the context shares the current answer and fix');
  return <LocationContext.Provider value={shared}>{children}</LocationContext.Provider>;
}

/** Starts the one ask and the one watch; returns the teardown, which also stops a watch that starts late. */
function startWatch(sink: Report): () => void {
  invariant(typeof sink.answer === 'function' && typeof sink.publish === 'function', 'the watch reports to the provider');
  const watch: Watch = { stopped: false, answered: false, subscription: null };
  const report = whileMounted(watch, sink);
  detach(
    watchPosition(watch, report).then((subscription) => adopt(watch, subscription)),
    (message) => failed(watch, report, message),
  );
  invariant(watch.subscription === null, 'the watch starts asynchronously');
  return () => {
    watch.stopped = true;
    watch.subscription?.remove();
  };
}

/** The provider's reports, dropped once the provider has gone. */
function whileMounted(watch: Watch, sink: Report): Report {
  invariant(!watch.stopped, 'reports are made for a running watch');
  const report: Report = {
    answer: (location) => (watch.stopped ? undefined : sink.answer(location)),
    publish: (position) => (watch.stopped ? undefined : sink.publish(position)),
  };
  invariant(report.answer !== sink.answer && report.publish !== sink.publish, 'every report is guarded');
  return report;
}

/**
 * Asks once, then watches the position; null without a grant (after reporting why), or when the provider
 * went while the answer was on its way — then no watch is opened at all.
 */
async function watchPosition(watch: Watch, report: Report): Promise<Unwatch | null> {
  invariant(watch.subscription === null, 'the provider opens one watch');
  invariant(typeof report.answer === 'function', 'the ask reports its answer');
  const grant = await askForLocation();
  watch.answered = true;
  if (!grant.ok) {
    const problem = grant.error.kind === 'failed' ? grant.error.message : null;
    report.answer({ kind: 'denied', problem });
    report.publish(unlocated(problem));
    return null;
  }
  report.answer({ kind: 'granted' });
  if (watch.stopped) {
    return null;
  }
  const options = { accuracy: Location.Accuracy.Balanced, distanceInterval: WATCH_DISTANCE_M };
  const subscription = await Location.watchPositionAsync(options, (fix) => report.publish(fixed(positionOf(fix), takenAtOf(fix))), (reason) => report.publish(unlocated(reason)));
  invariant(typeof subscription.remove === 'function', 'expo-location returns a removable watch');
  return subscription;
}

/** Keeps the started watch, or removes it at once when the provider has already gone. */
function adopt(watch: Watch, subscription: Unwatch | null): void {
  invariant(watch.subscription === null, 'a watch is adopted once');
  invariant(subscription === null || typeof subscription.remove === 'function', 'a watch can be stopped');
  if (subscription !== null && watch.stopped) {
    subscription.remove();
  } else {
    watch.subscription = subscription;
  }
}

/**
 * The ask or the watch broke (a rejection detach caught): no fix, and the reason. A grant already given
 * stands (the map's dot is MapKit's own); an ask that never answered counts as denied, with the reason.
 */
function failed(watch: Watch, report: Report, message: string): void {
  invariant(message.length > 0, 'a failure says why');
  invariant(watch.subscription === null, 'a watch that started did not fail');
  report.publish(unlocated(message));
  if (!watch.answered) {
    report.answer({ kind: 'denied', problem: message });
  }
}
