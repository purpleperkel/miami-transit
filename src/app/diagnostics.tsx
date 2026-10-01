import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { DiagnosticsScreen } from '@/ui/diagnostics/DiagnosticsScreen';

/** /diagnostics — the M1 capability probes (reached from Data & Settings, which the tab bar's data-version accessory opens). */
export default function DiagnosticsRoute() {
  invariant(typeof DiagnosticsScreen === 'function', 'the Diagnostics screen component exists');
  const screen = <DiagnosticsScreen />;
  invariant(isValidElement(screen) && screen.type === DiagnosticsScreen, 'the route renders the Diagnostics screen');
  return screen;
}
