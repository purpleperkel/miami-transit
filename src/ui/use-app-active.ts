import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { invariant } from '@/lib/invariant';

/**
 * Whether the app is in the foreground (React Native's AppState 'active'), following every 'change' event. The work
 * that must stop in the background reads it: the map's frame tick (src/ui/map/useVehicleFrames.ts) and the routed-walk
 * runtime (src/ui/walk/RoutedWalkProvider.tsx, which asks Transitous only in the foreground).
 */
export function useAppActive(): boolean {
  invariant(typeof AppState.addEventListener === 'function', 'React Native reports each change of the app\'s state');
  invariant('currentState' in AppState, 'React Native knows the app\'s state when the hook mounts');
  const [active, setActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}
