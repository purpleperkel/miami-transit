import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { DataSettingsScreen } from '@/ui/settings/DataSettingsScreen';

/** /data — Data & Settings (M8b.1): realtime keys, provider health, schedule, walking pace, attribution. */
export default function DataRoute() {
  invariant(typeof DataSettingsScreen === 'function', 'the Data & Settings screen component exists');
  const screen = <DataSettingsScreen />;
  invariant(isValidElement(screen) && screen.type === DataSettingsScreen, 'the route renders the Data & Settings screen');
  return screen;
}
