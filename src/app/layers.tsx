import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { useLayers } from '@/ui/map/layers-store';
import { LayersSheet } from '@/ui/map/LayersSheet';

/** /layers — the Layers sheet (M5.12), a formSheet over the map: its switches change the shared layers store the map draws from. */
export default function LayersRoute() {
  const { layers, problem, toggle } = useLayers();
  invariant(typeof toggle === 'function', 'the sheet changes the layers');
  const sheet = <LayersSheet layers={layers} problem={problem} onToggle={toggle} />;
  invariant(isValidElement(sheet) && sheet.type === LayersSheet, 'the route renders the Layers sheet');
  return sheet;
}
