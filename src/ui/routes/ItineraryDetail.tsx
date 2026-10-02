import { PlatformColor, StyleSheet, View } from 'react-native';

import type { OpenUrl } from '@/domain/handoff/apple-maps';
import type { Leg } from '@/domain/routes/transitous';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { formatDistance } from '../format';
import { ActionButton } from '../primitives/ActionButton';
import { type Freshness, FreshnessIndicator } from '../primitives/FreshnessIndicator';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { legTarget, openDirections, walkDirectionsUrl } from './leg-actions';
import { durationText, legBadge, legEnds, modeWord, optionFacts, type PlaceNames, type RouteClock, type RouteNetwork, type RouteOption } from './route-options';
import { ConnectionRisk, LegBadgeView } from './RouteOptionsList';
import { linkingOpenURL, useOpenLink } from './use-open-link';

/**
 * Plan M10b.2: one route option, leg by leg, inside the route options sheet. Every leg shows its times.
 *
 *   walk      "Walk 5 min · 320 m", where to, and "Directions": Apple Maps walking directions to the
 *             leg's end (dirflg=w, leg-actions.ts); success is openURL resolving, a refusal is said
 *             under the button
 *   transit   its line badge (m6a's LineBadge, or the route's name), where it heads, the station it
 *             leaves from and the one to get off at, and whether its departure is Live or Scheduled
 */

const LIVE: Freshness = Object.freeze({ kind: 'live' });
const SCHEDULED: Freshness = Object.freeze({ kind: 'scheduled' });

export type ItineraryDetailProps = {
  readonly option: RouteOption;
  readonly network: RouteNetwork;
  readonly names: PlaceNames;
  readonly clock: RouteClock;
  /** React Native's Linking.openURL unless a test passes its own. */
  readonly openURL?: OpenUrl;
  /** Back to every option; no button without it. */
  readonly onBack?: () => void;
};

export function ItineraryDetail({ option, network, names, clock, openURL = linkingOpenURL, onBack }: ItineraryDetailProps) {
  const facts = optionFacts(option, clock);
  const legs = option.itinerary.legs;
  invariant(legs.length > 0, 'an itinerary has legs');
  invariant(names.origin.length > 0 && names.destination.length > 0, 'the trip\'s ends are named');
  return (
    <View testID="itinerary-detail" style={styles.detail}>
      {onBack === undefined ? null : <ActionButton testID="itinerary-back" symbol="chevron.left" label={copy.allOptions} hint={copy.allOptionsHint} onPress={onBack} />}
      <TText testID="itinerary-times" variant="title">
        {facts.times}
      </TText>
      <TText testID="itinerary-facts" variant="subhead" tone="secondary">
        {[facts.duration, facts.transfers, facts.walk].join(' · ')}
      </TText>
      {option.connectionAtRisk === null ? null : <ConnectionRisk testID="itinerary-risk" text={option.connectionAtRisk} />}
      {legs.map((_, j) => (
        <LegView key={`leg-${j}`} option={option} index={j} network={network} names={names} clock={clock} openURL={openURL} />
      ))}
    </View>
  );
}

type LegViewProps = Omit<ItineraryDetailProps, 'onBack' | 'openURL'> & { readonly index: number; readonly openURL: OpenUrl };

/** Leg `index` of the option: a walk, or a ride. */
function LegView({ option, index, network, names, clock, openURL }: LegViewProps) {
  const leg = option.itinerary.legs[index];
  invariant(leg !== undefined, `the itinerary has a leg ${index}`);
  const ends = legEnds(option.itinerary, index, network, names);
  const id = `leg-${index}`;
  invariant(ends.from.length > 0 && ends.to.length > 0, 'both ends of the leg are named');
  return leg.tripId === null ? <WalkLeg id={id} leg={leg} to={ends.to} clock={clock} openURL={openURL} /> : <TransitLeg id={id} leg={leg} ends={ends} network={network} clock={clock} />;
}

type WalkLegProps = { readonly id: string; readonly leg: Leg; readonly to: string; readonly clock: RouteClock; readonly openURL: OpenUrl };

/** A walk: how long and how far, where to, and Apple Maps walking directions to its end. */
function WalkLeg({ id, leg, to, clock, openURL }: WalkLegProps) {
  const { failure, open } = useOpenLink(openDirections, openURL);
  const how = [`${modeWord(leg.mode)} ${durationText(leg.durationS)}`, leg.distanceM === null ? null : formatDistance(leg.distanceM)].filter((part) => part !== null).join(' · ');
  invariant(how.length > 0 && to.length > 0, 'a walk says how long, and where to');
  invariant(leg.tripId === null, 'a walk rides no trip');
  return (
    <View testID={id} style={styles.leg}>
      <TText testID={`${id}-times`} variant="footnote" tone="secondary">{`${clock(leg.from.epoch)} – ${clock(leg.to.epoch)}`}</TText>
      <TText testID={`${id}-walk`} variant="headline">
        {how}
      </TText>
      <TText testID={`${id}-to`} variant="subhead" tone="secondary">{`to ${to}`}</TText>
      <ActionButton testID={`${id}-directions`} symbol="figure.walk" label={copy.directions} hint={copy.legDirectionsHint} onPress={() => open(walkDirectionsUrl(legTarget(leg)))} />
      {failure === null ? null : (
        <TText testID={`${id}-failed`} variant="footnote" accessibilityLiveRegion="polite" style={styles.failure}>
          {failure}
        </TText>
      )}
    </View>
  );
}

type TransitLegProps = { readonly id: string; readonly leg: Leg; readonly ends: { readonly from: string; readonly to: string }; readonly network: RouteNetwork; readonly clock: RouteClock };

/** A ride: its line, where it heads, where to board and get off (with times), and Live or Scheduled. */
function TransitLeg({ id, leg, ends, network, clock }: TransitLegProps) {
  const badge = legBadge(leg, network);
  invariant(badge !== null, 'a ride has a badge');
  invariant(ends.from.length > 0 && ends.to.length > 0, 'a ride boards and alights somewhere');
  return (
    <View testID={id} style={styles.leg}>
      <View style={styles.line}>
        <LegBadgeView badge={badge} testID={`${id}-badge`} />
        {leg.headsign === null ? null : (
          <TText testID={`${id}-headsign`} variant="subhead" numberOfLines={1} style={styles.headsign}>
            {leg.headsign}
          </TText>
        )}
        <FreshnessIndicator testID={`${id}-source`} freshness={leg.live ? LIVE : SCHEDULED} />
      </View>
      <TText testID={`${id}-board`} variant="headline">{`${clock(leg.from.epoch)}  ${ends.from}`}</TText>
      <TText testID={`${id}-alight`} variant="headline">{`${clock(leg.to.epoch)}  ${ends.to}`}</TText>
    </View>
  );
}

const styles = StyleSheet.create({
  detail: { gap: SPACING.sm },
  leg: { gap: SPACING.xxs, padding: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  headsign: { flexShrink: 1 },
  failure: { color: PlatformColor('systemRed') },
});
