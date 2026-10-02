import { PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { CountdownHero } from './CountdownHero';
import type { TripCardModel } from './trip-card';
import { untimedText } from './trip-copy';

export type TripCardProps = {
  readonly card: TripCardModel;
  readonly nowS: number;
  /** A tap on the card (the Trips tab opens the trip's screen); absent on the trip's own screen. */
  readonly onOpen?: (tripId: string) => void;
};

/**
 * One saved trip (plan M7.8): its name and stations, then the CountdownHero counting to the ride it
 * should take — or, with no ride to count to, why not in words ("No trains now" at night, never
 * "transfer"). Cards are solid, never glass (plan §4: glass is for floating chrome only).
 */
export function TripCard({ card, nowS, onOpen }: TripCardProps) {
  invariant(card.trip.id.length > 0, 'a card is a saved trip');
  invariant(Number.isSafeInteger(nowS), 'a card is drawn at a whole second');
  const route = `${card.fromName} → ${card.toName}`;
  const body =
    card.status.kind === 'leave' ? (
      <CountdownHero tripId={card.trip.id} tripName={card.trip.name} status={card.status} walk={card.walk} nowS={nowS} />
    ) : (
      <Untimed card={card} />
    );
  const content = (
    <View style={styles.card}>
      <TText testID="trip-card-name" variant="headline">
        {card.trip.name}
      </TText>
      {card.trip.name === route ? null : (
        <TText testID="trip-card-route" variant="subhead" tone="secondary">
          {route}
        </TText>
      )}
      {body}
    </View>
  );
  if (onOpen === undefined) {
    return <View testID={`trip-card-${card.trip.id}`}>{content}</View>;
  }
  return (
    <Pressable testID={`trip-card-${card.trip.id}`} accessibilityRole="button" accessibilityHint="Opens the trip" onPress={() => onOpen(card.trip.id)} style={({ pressed }) => (pressed ? styles.pressed : null)}>
      {content}
    </Pressable>
  );
}

/** A card with no ride to count to: the reason as a title and a line of detail. */
function Untimed({ card }: { readonly card: TripCardModel }) {
  invariant(card.status.kind !== 'leave', 'an untimed card has no ride');
  const said = untimedText(card, card.status);
  invariant(said.title.length > 0, 'an untimed card says why');
  return (
    <View testID="trip-card-untimed" style={styles.untimed}>
      <TText variant="title">{said.title}</TText>
      <TText variant="subhead" tone="secondary">
        {said.detail}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderRadius: RADIUS.lg,
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
  },
  untimed: { gap: SPACING.xxs },
  pressed: { opacity: 0.6 },
});
