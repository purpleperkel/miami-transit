import { PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import type { OpenUrl } from '@/domain/handoff/apple-maps';
import type { HurryVerdict } from '@/domain/hurry/verdict';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { type HurryCopyContext, hurryShort, hurrySentence } from '../hurry/copy';
import { type Freshness, FreshnessIndicator } from '../primitives/FreshnessIndicator';
import { LineBadge } from '../primitives/LineBadge';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { openLink } from './leg-actions';
import { badgeLabel, type LegBadge, type OptionFacts, optionFacts, type RouteClock, type RouteOption } from './route-options';
import { linkingOpenURL, useOpenLink } from './use-open-link';

/**
 * Plan M10b.1: the route options, scannable at a glance (Jamie: "easily get route options … and know
 * 'is it worth it to hurry/jog'"). One row per option, earliest arrival first:
 *
 *   2:01 → 2:21                             Chill · 1 min spare      ← the first leg's hurry chip
 *   20 min   No transfers   13 min walk
 *   [Brickell] [Orange]   ((·)) Live                                ← line badges, Live when overlaid
 *
 * A walk-only option (mfix7: Transitous's direct answer, when walking beats every train) reads
 * "Walk 8 min · no train needed" under its times, with no badges, no Live badge and no hurry chip.
 *
 * A row opens its itinerary (ItineraryDetail) inside the sheet. Under the list, the attribution
 * Transitous's terms ask of an open client — "Routes by Transitous", linking its data sources — and the
 * OpenStreetMap credit its API page requires for the walking it routes on OSM data.
 */

/** Transitous's data sources page, which the attribution links (transitous.org/api). */
export const TRANSITOUS_SOURCES_URL = 'https://transitous.org/sources';
/** OpenStreetMap's copyright and licence page, which its credit links. */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

const LIVE: Freshness = Object.freeze({ kind: 'live' });

export type RouteOptionsListProps = {
  readonly options: readonly RouteOption[];
  readonly clock: RouteClock;
  /** Now, epoch s: the hurry chips count from it. */
  readonly nowS: number;
  /** Opens option `id` (RouteOption.id). */
  readonly onSelect: (id: number) => void;
};

export function RouteOptionsList({ options, clock, nowS, onSelect }: RouteOptionsListProps) {
  invariant(options.length > 0, 'the list has options (the sheet says so when there are none)');
  invariant(Number.isFinite(nowS), 'the list is drawn at an instant');
  const ctx: HurryCopyContext = { now: nowS, clock };
  return (
    <View testID="route-options" style={styles.list}>
      {options.map((option, index) => (
        <RouteOptionRow key={option.id} option={option} index={index} clock={clock} ctx={ctx} onSelect={onSelect} />
      ))}
    </View>
  );
}

type RowProps = { readonly option: RouteOption; readonly index: number; readonly clock: RouteClock; readonly ctx: HurryCopyContext; readonly onSelect: (id: number) => void };

function RouteOptionRow({ option, index, clock, ctx, onSelect }: RowProps) {
  const facts = optionFacts(option, clock);
  const id = `route-option-${index}`;
  const said = facts.walkOnly === null ? [facts.duration, facts.transfers, facts.walk] : [facts.walkOnly.replace(' · ', ', ')];
  const label = [facts.times.replace('→', 'to'), ...said, ...option.badges.map(badgeLabel), option.live ? 'Live' : null, option.connectionAtRisk]
    .filter((part) => part !== null)
    .join(', ');
  invariant(label.length > facts.times.length, 'VoiceOver hears every fact of the row');
  invariant(index >= 0, 'a row has a place in the list');
  return (
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={copy.optionHint} onPress={() => onSelect(option.id)} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <View style={styles.top}>
        <TText testID={`${id}-times`} variant="headline">
          {facts.times}
        </TText>
        {option.verdict === null ? null : <HurryChip testID={`${id}-hurry`} verdict={option.verdict} ctx={ctx} />}
      </View>
      <FactsLine id={id} facts={facts} />
      <View style={styles.badges}>
        {option.badges.map((badge, j) => (
          <LegBadgeView key={`${j}-${badgeLabel(badge)}`} badge={badge} testID={`${id}-badge-${j}`} />
        ))}
        {option.live ? <FreshnessIndicator testID={`${id}-live`} freshness={LIVE} /> : null}
      </View>
      {option.connectionAtRisk === null ? null : <ConnectionRisk testID={`${id}-risk`} text={option.connectionAtRisk} />}
    </Pressable>
  );
}

/** Under the times: the duration, transfers and walk of a ride — or, for a walk-only option, "Walk 8 min · no train needed". */
function FactsLine({ id, facts }: { readonly id: string; readonly facts: OptionFacts }) {
  invariant(id.startsWith('route-option-'), 'the facts belong to a row');
  invariant(facts.duration.length > 0, 'an option takes a time');
  if (facts.walkOnly !== null) {
    return (
      <View style={styles.facts}>
        <TText testID={`${id}-walk-only`} variant="subhead">
          {facts.walkOnly}
        </TText>
      </View>
    );
  }
  return (
    <View style={styles.facts}>
      <TText testID={`${id}-duration`} variant="subhead">
        {facts.duration}
      </TText>
      <TText testID={`${id}-transfers`} variant="subhead" tone="secondary">
        {facts.transfers}
      </TText>
      <TText testID={`${id}-walk`} variant="subhead" tone="secondary">
        {facts.walk}
      </TText>
    </View>
  );
}

/** A transfer a late leg may break: "Tight transfer · may miss 26" (mfix5), on the row and in its detail. */
export function ConnectionRisk({ text, testID }: { readonly text: string; readonly testID: string }) {
  invariant(text.length > 0, 'a missed-connection warning names the line');
  invariant(testID.endsWith('-risk'), 'the warning is the option\'s risk line');
  return (
    <TText testID={testID} variant="subhead" style={styles.risk}>
      {text}
    </TText>
  );
}

/** A transit leg's badge: m6a's LineBadge for a catalog line, a neutral capsule with the route's name otherwise. */
export function LegBadgeView({ badge, testID }: { readonly badge: LegBadge; readonly testID?: string }) {
  invariant(badge.kind === 'line' || badge.text.length > 0, 'a badge has words');
  invariant(testID === undefined || testID.length > 0, 'a badge test id is a name');
  if (badge.kind === 'line') {
    return <LineBadge lineId={badge.lineId} testID={testID} />;
  }
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={badge.label} style={styles.routeBadge}>
      <TText variant="footnote" numberOfLines={1} style={styles.routeText}>
        {badge.text}
      </TText>
    </View>
  );
}

/** The first leg's hurry or chill in the short, labelled copy ("Chill · 1 min spare", mfix8); VoiceOver reads the full sentence. */
function HurryChip({ verdict, ctx, testID }: { readonly verdict: HurryVerdict; readonly ctx: HurryCopyContext; readonly testID: string }) {
  const text = hurryShort(verdict, ctx);
  const sentence = hurrySentence(verdict, ctx);
  invariant(text.length > 0 && sentence.length > text.length, 'the chip says the verdict, VoiceOver the sentence');
  invariant(testID.endsWith('-hurry'), 'the chip is the row\'s hurry chip');
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={sentence} style={styles.chip}>
      <TText testID={`${testID}-text`} variant="footnote" numberOfLines={1} style={styles.chipText}>
        {text}
      </TText>
    </View>
  );
}

/**
 * The credits the routes need: "Routes by Transitous" linking its data sources (its terms for open
 * clients) and "© OpenStreetMap contributors" (its API page: the walking is routed on OSM data, ODbL).
 */
export function RoutesAttribution({ openURL = linkingOpenURL }: { readonly openURL?: OpenUrl }) {
  const { failure, open } = useOpenLink(openLink, openURL);
  invariant(TRANSITOUS_SOURCES_URL.startsWith('https://') && OSM_COPYRIGHT_URL.startsWith('https://'), 'the credits link real pages');
  invariant(failure === null || failure.length > 0, 'a failure says something');
  return (
    <View testID="routes-attribution" style={styles.attribution}>
      <Pressable testID="routes-attribution-transitous" accessibilityRole="link" accessibilityHint={copy.transitousSourcesHint} onPress={() => open(TRANSITOUS_SOURCES_URL)}>
        <TText variant="footnote" style={styles.link}>Routes by Transitous</TText>
      </Pressable>
      <Pressable testID="routes-attribution-osm" accessibilityRole="link" accessibilityHint={copy.osmCopyrightHint} onPress={() => open(OSM_COPYRIGHT_URL)}>
        <TText variant="footnote" tone="secondary">© OpenStreetMap contributors</TText>
      </Pressable>
      {failure === null ? null : (
        <TText testID="routes-attribution-failed" variant="footnote" style={styles.failure}>
          {failure}
        </TText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: SPACING.xs },
  row: { gap: SPACING.xxs, padding: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  pressed: { opacity: 0.6 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.xs },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACING.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xxs },
  routeBadge: { borderRadius: RADIUS.xl, paddingHorizontal: SPACING.xs, paddingVertical: 2, backgroundColor: PlatformColor('systemGray4') },
  routeText: { fontWeight: '600' },
  chip: { borderRadius: RADIUS.xl, paddingHorizontal: SPACING.xs, paddingVertical: 2, backgroundColor: PlatformColor('tertiarySystemFill') },
  chipText: { fontWeight: '600' },
  risk: { color: PlatformColor('systemOrange'), fontWeight: '600' },
  attribution: { alignItems: 'center', gap: SPACING.xxs, paddingVertical: SPACING.md },
  link: { color: PlatformColor('link') },
  failure: { color: PlatformColor('systemRed') },
});
