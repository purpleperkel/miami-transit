import { useLocalSearchParams } from 'expo-router';

import { invariant } from '@/lib/invariant';
import { readStep } from '@/ui/trips/add/add-trip';
import { ToStep } from '@/ui/trips/add/AddTripSteps';

/** /trip/new/to?from=… — the second step (M7.9): where the trip goes; opened from step one or a station sheet's "Save trip". */
export default function AddTripToRoute() {
  const params = useLocalSearchParams<{ from?: string }>();
  const step = readStep(params);
  invariant(step !== null, `the destination step is opened from a station, got ${JSON.stringify(params)}`);
  invariant(step.from.includes(':'), 'the origin is a station key');
  return <ToStep from={step.from} />;
}
