import { useLocalSearchParams } from 'expo-router';

import { invariant } from '@/lib/invariant';
import { readStep } from '@/ui/trips/add/add-trip';
import { ConfirmStep } from '@/ui/trips/add/ConfirmStep';

/** /trip/new/confirm?from=…&to=…&walk=… — the last step (M7.9): the trip's name and reminders, then Save. */
export default function AddTripConfirmRoute() {
  const params = useLocalSearchParams<{ from?: string; to?: string; walk?: string; walkMin?: string; startLat?: string; startLon?: string }>();
  const step = readStep(params);
  invariant(step !== null && step.to !== null && step.walk !== null, `the last step knows both stations and the walk, got ${JSON.stringify(params)}`);
  invariant(step.from !== step.to, 'a trip joins two stations');
  return <ConfirmStep from={step.from} to={step.to} walk={step.walk} />;
}
