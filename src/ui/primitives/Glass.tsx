import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { PlatformColor, StyleSheet, View, type ViewProps } from 'react-native';

import { invariant } from '@/lib/invariant';

import { RADIUS } from '../tokens';

export type GlassProps = ViewProps & { readonly children: ReactNode };

/**
 * The surface of floating chrome over the map: the Now strip, the status pill and the control stack
 * (plan §4: glass only on floating chrome; lists and cards are solid). It is Liquid Glass where iOS
 * provides it (expo-glass-effect's GlassView, iOS 26+). Elsewhere it falls back to a solid system
 * background with a soft shadow. Per the SDK 57 docs, isLiquidGlassAvailable() reports whether the
 * components exist, not the user's Reduce Transparency setting.
 */
export function Glass({ children, style, ...rest }: GlassProps) {
  const liquid = isLiquidGlassAvailable();
  invariant(typeof liquid === 'boolean', 'isLiquidGlassAvailable answers yes or no');
  invariant(children !== undefined && children !== null, 'a glass surface holds content');
  if (liquid) {
    return (
      <GlassView {...rest} glassEffectStyle="regular" style={[styles.surface, style]}>
        {children}
      </GlassView>
    );
  }
  return (
    <View {...rest} style={[styles.surface, styles.solid, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { borderRadius: RADIUS.lg },
  solid: {
    backgroundColor: PlatformColor('systemBackground'),
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
});
