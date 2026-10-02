import { useCallback, useState } from 'react';
import { PlatformColor, Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { StationListing } from '@/data/schedule-queries';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { type Geocoder, geocodePlace, searchPlace } from './place-search';
import type { RecentPlace } from './recent-places';
import { type PlaceSuggestion, stationSuggestions } from './route-options';

/**
 * Plan M10b.1: the sheet's "To". Typing filters what is one tap away — recent places (ruling R6, newest
 * first) and stations whose names match — and submitting (or "Search for …") asks the system geocoder
 * (place-search.ts). A chosen place shows in the field; typing again clears it and offers the list.
 */

/** At most this many recent places and stations are offered. */
export const MAX_SUGGESTIONS = 5;

export type PlanDestinationProps = {
  readonly destination: RecentPlace | null;
  readonly recents: readonly RecentPlace[];
  readonly stations: readonly StationListing[];
  readonly onChoose: (place: RecentPlace) => void;
  readonly onClear: () => void;
  readonly geocode?: Geocoder;
};

export function PlanDestination({ destination, recents, stations, onChoose, onClear, geocode = geocodePlace }: PlanDestinationProps) {
  const [words, setWords] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const choose = useCallback((place: RecentPlace) => chooseInto(place, setWords, setNote, onChoose), [onChoose]);
  const type = useCallback((next: string) => typeInto(next, destination !== null, setWords, setNote, onClear), [destination, onClear]);
  const search = useCallback(() => startSearch(words, geocode, choose, setNote), [words, geocode, choose]);
  invariant(destination === null || destination.name.length > 0, 'a chosen destination is named');
  invariant(typeof onChoose === 'function' && typeof onClear === 'function', 'the field reports its choice');
  return (
    <View testID="plan-destination" style={styles.field}>
      <TText variant="footnote" tone="secondary">
        {copy.routeTo}
      </TText>
      <TextInput
        testID="plan-to"
        value={destination?.name ?? words}
        placeholder={copy.whereTo}
        onChangeText={type}
        onSubmitEditing={search}
        returnKeyType="search"
        autoCorrect={false}
        clearButtonMode="while-editing"
        accessibilityLabel={copy.routeTo}
        style={styles.input}
      />
      {note === null ? null : (
        <TText testID="plan-to-note" variant="footnote" style={styles.note}>
          {note}
        </TText>
      )}
      {destination === null ? <Suggestions words={words} recents={recents} stations={stations} onChoose={choose} onSearch={search} /> : null}
    </View>
  );
}

function chooseInto(place: RecentPlace, setWords: (words: string) => void, setNote: (note: string | null) => void, onChoose: (place: RecentPlace) => void): void {
  invariant(place.name.length > 0, 'a chosen place is named');
  invariant(typeof onChoose === 'function', 'the choice is reported');
  setWords(place.name);
  setNote(null);
  onChoose(place);
}

function typeInto(next: string, chosen: boolean, setWords: (words: string) => void, setNote: (note: string | null) => void, onClear: () => void): void {
  invariant(typeof next === 'string', 'the field holds text');
  invariant(typeof onClear === 'function', 'a cleared choice is reported');
  setWords(next);
  setNote(null);
  if (chosen) {
    onClear();
  }
}

/** Geocodes the words; a match becomes the destination, anything else is said under the field. */
function startSearch(words: string, geocode: Geocoder, choose: (place: RecentPlace) => void, setNote: (note: string | null) => void): void {
  invariant(typeof geocode === 'function', 'a search has a geocoder');
  invariant(typeof setNote === 'function', 'a search can say it found nothing');
  if (words.trim().length === 0) {
    return;
  }
  searchPlace(words, geocode).then(
    (found) => (found.ok ? choose(found.value) : setNote(found.error)),
    (error: unknown) => setNote(`${copy.searchFailed}: ${String(error)}`),
  );
}

type SuggestionsProps = {
  readonly words: string;
  readonly recents: readonly RecentPlace[];
  readonly stations: readonly StationListing[];
  readonly onChoose: (place: RecentPlace) => void;
  readonly onSearch: () => void;
};

/** "Search for …", the matching recent places, then the matching stations. */
function Suggestions({ words, recents, stations, onChoose, onSearch }: SuggestionsProps) {
  const needle = words.trim().toLowerCase();
  const recent: PlaceSuggestion[] = recents.filter((place) => place.name.toLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS).map((place) => ({ ...place, detail: null }));
  const matching = stationSuggestions(words, stations, MAX_SUGGESTIONS);
  invariant(recent.length <= MAX_SUGGESTIONS && matching.length <= MAX_SUGGESTIONS, 'the suggestions are capped');
  invariant(needle.length > 0 || matching.length === 0, 'stations are offered for typed words only');
  return (
    <View testID="plan-suggestions" style={styles.suggestions}>
      {needle.length === 0 ? null : <SuggestionRow testID="plan-search" title={copy.searchPlace(words.trim())} detail={null} onPress={onSearch} />}
      {recent.length === 0 ? null : <TText variant="footnote" tone="secondary">{copy.recentPlaces}</TText>}
      {recent.map((place, i) => (
        <SuggestionRow key={`recent-${place.name}`} testID={`plan-recent-${i}`} title={place.name} detail={null} onPress={() => onChoose({ name: place.name, lat: place.lat, lon: place.lon })} />
      ))}
      {matching.length === 0 ? null : <TText variant="footnote" tone="secondary">{copy.stationPlaces}</TText>}
      {matching.map((place, i) => (
        <SuggestionRow key={`station-${i}-${place.name}`} testID={`plan-station-${i}`} title={place.name} detail={place.detail} onPress={() => onChoose({ name: place.name, lat: place.lat, lon: place.lon })} />
      ))}
    </View>
  );
}

type SuggestionRowProps = { readonly testID: string; readonly title: string; readonly detail: string | null; readonly onPress: () => void };

function SuggestionRow({ testID, title, detail, onPress }: SuggestionRowProps) {
  invariant(title.length > 0, 'a suggestion is named');
  invariant(typeof onPress === 'function', 'a suggestion can be chosen');
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={detail === null ? title : `${title}, ${detail}`} onPress={onPress} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <TText variant="body">{title}</TText>
      {detail === null ? null : (
        <TText variant="footnote" tone="secondary">
          {detail}
        </TText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { gap: SPACING.xxs },
  input: {
    minHeight: 44,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md,
    fontSize: 17,
    color: PlatformColor('label'),
    backgroundColor: PlatformColor('tertiarySystemFill'),
  },
  note: { color: PlatformColor('systemRed') },
  suggestions: { gap: SPACING.xxs, paddingTop: SPACING.xs },
  row: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  pressed: { opacity: 0.6 },
});
