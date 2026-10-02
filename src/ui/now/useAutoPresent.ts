import { useIsFocused } from 'expo-router';
import { useEffect } from 'react';

import { invariant } from '@/lib/invariant';

import { openStationSheet } from '../sheets';
import { NOW_STORE, type NowStore, useNowState } from './nowStore';

/**
 * Plan M7.7 "auto-present": when the rider is AT a station (the home context the Now strip published to
 * the Now store), the Map tab presents that station's sheet — its next trains — without a tap; once per
 * visit (leaving the station resets it), never while the rider is exploring the map (homeContext.ts), and
 * only while the Map tab itself is in front: not over the Trips tab, a pushed screen or another sheet.
 */
export function useAutoPresent(store: NowStore = NOW_STORE): void {
  const { context } = useNowState(store);
  const focused = useIsFocused();
  const present = focused && context !== null && context.kind === 'station' && context.autoPresent ? context.stationKey : null;
  const away = context !== null && context.kind !== 'station';
  useEffect(() => (away ? store.leftStation() : undefined), [store, away]);
  useEffect(() => (present === null ? undefined : presentStation(store, present)), [store, present]);
  invariant(present === null || present.includes(':'), 'a presented station is keyed mode:name');
  invariant(!(present !== null && away), 'the rider is at the station presented');
}

/** Marks the station presented (so it shows once per visit), then opens its sheet. */
function presentStation(store: NowStore, stationKey: string): void {
  invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  store.markPresented(stationKey);
  invariant(store.read().presentedKey === stationKey, 'the station is marked before its sheet opens');
  openStationSheet(stationKey);
}
