import { useLocalSearchParams } from 'expo-router';

import { invariant } from '@/lib/invariant';
import { readStep } from '@/ui/trips/add/add-trip';
import { WalkStep } from '@/ui/trips/add/WalkStep';

/** /trip/new/start?from=…&to=… — the third step (M7.9): how far the walk to the boarding station is. */
export default function AddTripStartRoute() {
  const params = useLocalSearchParams<{ from?: string; to?: string }>();
  const step = readStep(params);
  invariant(step !== null && step.to !== null, `the walk step knows both stations, got ${JSON.stringify(params)}`);
  invariant(step.from !== step.to, 'a trip joins two stations');
  return <WalkStep from={step.from} to={step.to} />;
}
