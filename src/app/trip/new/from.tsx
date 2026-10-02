import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { FromStep } from '@/ui/trips/add/AddTripSteps';

/** /trip/new/from — the add-trip flow's first step (M7.9): the station the trip leaves from. */
export default function AddTripFromRoute() {
  invariant(typeof FromStep === 'function', 'the first step exists');
  const step = <FromStep />;
  invariant(isValidElement(step) && step.type === FromStep, 'the route renders the first step');
  return step;
}
