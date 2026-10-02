import { StyleSheet, useColorScheme, View } from 'react-native';

import { type LineId, lineById } from '@/domain/lines/line-catalog';
import { invariant } from '@/lib/invariant';

import { type ColorScheme, lineColors } from '../colors';
import { RADIUS, SPACING } from '../tokens';
import { TText } from './TText';

export type LineBadgeProps = {
  readonly lineId: LineId;
  readonly testID?: string;
};

/** The words on a badge: the catalog name without a trailing " Line" ("Orange", "Inner Loop", "Omni"). */
export function badgeText(lineId: LineId): string {
  const name = lineById(lineId).name;
  const text = name.replace(/ Line$/, '');
  invariant(text.length > 0 && name.startsWith(text), `the badge text of ${lineId} is its name, shortened`);
  invariant(text.length <= name.length, 'shortening never lengthens');
  return text;
}

/**
 * A line, as a list shows it (plan M6.2): a capsule filled with the line's stroke colour and lettered
 * with its name in the palette's badge text (src/ui/colors.ts). Never colour alone (§4): the name is
 * written on the badge, and VoiceOver reads the line's full catalog name (src/domain/lines/line-catalog.ts).
 * The text scales with Dynamic Type; the colours follow the system light or dark scheme.
 */
export function LineBadge({ lineId, testID }: LineBadgeProps) {
  const scheme = useBadgeScheme();
  const colors = lineColors(lineId, scheme);
  const name = lineById(lineId).name;
  invariant(name.trim().length > 0, `${lineId} has a catalog name for VoiceOver`);
  invariant(colors.badgeText !== colors.stroke, `the ${lineId} badge text stands out from its fill`);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={name}
      style={[styles.badge, { backgroundColor: colors.stroke }]}>
      <TText variant="footnote" numberOfLines={1} style={[styles.text, { color: colors.badgeText }]}>
        {badgeText(lineId)}
      </TText>
    </View>
  );
}

/** The scheme badges are drawn in: the system's, light when it says nothing. */
function useBadgeScheme(): ColorScheme {
  const system = useColorScheme();
  const scheme: ColorScheme = system === 'dark' ? 'dark' : 'light';
  invariant(scheme === 'light' || scheme === 'dark', 'a badge is drawn light or dark');
  invariant(system !== 'dark' || scheme === 'dark', 'a dark system gets dark badges');
  return scheme;
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: RADIUS.xl,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
  },
  text: { fontWeight: '600' },
});
