import { StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { formatDistance } from '../format';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { HURRY_NOTES } from './copy';
import type { HurryReading } from './hurry-reading';
import { HurryCard } from './HurryCard';
import { useHurryVerdict } from './useHurryVerdict';

/**
 * Plan M7c.3: hurry-or-chill on the station sheet, in the header's verdict slot (m6b R7): one HurryCard
 * per direction of the station ("To Dadeland South: Chill · 3 min to spare"), or one line saying why
 * there is no verdict yet. While the schedule opens, fails or has run out the sheet itself says so, and
 * the slot stays empty.
 *
 *   StationHurry (the hook) → StationHurryView (props only, rendered in tests)
 */

export type StationHurryProps = {
  readonly stationKey: string;
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

export function StationHurry({ stationKey, clock }: StationHurryProps) {
  invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  const reading = useHurryVerdict({ kind: 'station', stationKey }, clock);
  invariant(reading.kind !== 'boards' || reading.stationKey === stationKey, 'the sheet shows its own station\'s verdict');
  return <StationHurryView reading={reading} />;
}

export function StationHurryView({ reading }: { readonly reading: HurryReading }) {
  const note = noteOf(reading);
  invariant(reading.kind !== 'boards' || reading.boards.length > 0, 'a station reading has a board');
  invariant(reading.kind !== 'boards' || note === null, 'a verdict needs no note');
  if (reading.kind === 'boards') {
    return (
      <View testID="station-hurry" style={styles.boards}>
        {reading.boards.map(({ directionId, verdict, title, freshness }) => (
          <HurryCard key={directionId ?? 'none'} testID={`hurry-card-${directionId ?? 'none'}`} verdict={verdict} ctx={reading.ctx} title={title} freshness={freshness} />
        ))}
      </View>
    );
  }
  return note === null ? null : (
    <TText testID="station-hurry-note" variant="footnote" tone="secondary">
      {note}
    </TText>
  );
}

/** The one line shown instead of a verdict, or null where the sheet already explains (schedule opening, failed or out). */
function noteOf(reading: HurryReading): string | null {
  invariant(typeof reading.kind === 'string', 'a reading has a kind');
  const note =
    reading.kind === 'locating'
      ? HURRY_NOTES.locating
      : reading.kind === 'no-location'
        ? HURRY_NOTES.noLocation
        : reading.kind === 'far'
          ? HURRY_NOTES.far(formatDistance(reading.walkMeters))
          : null;
  invariant(note === null || note.endsWith('.') || note.endsWith('…'), 'a note is a full line');
  return note;
}

const styles = StyleSheet.create({
  boards: { gap: SPACING.sm },
});
