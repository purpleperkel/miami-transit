import { invariant } from '../../lib/invariant';
import { MODE_NAMES } from '../a11y';
import { copy } from '../copy';
import { formatClockFromServiceSec } from '../format';
import { hurryInline, hurryShort, hurrySentence, INLINE_MAX_CHARS } from '../hurry/copy';
import type { TripVerdict } from '../hurry/trip-verdict';
import type { CountdownState } from '../trips/countdown';
import type { TripCardModel } from '../trips/trip-card';
import { heroOf } from '../trips/trip-copy';
import type { SavedTripWalk } from '../trips/trip-walk';
import type { ActiveTrip, HomeContext } from './homeContext';
import { type AccessoryPlacement, fitsPlacement, type NowText, REGULAR_LINE_MAX_CHARS } from './now-text';

/**
 * What the Now bar says for the home context, and where a tap on it goes (M7.7; mfix8):
 *
 *   trip       ["Dadeland South", "Leave in 6 min"]                     inline "Leave in 6 min"   → the trip
 *   nearTrip   ["Bayfront Park", "Chill · 4 min spare · ~5 min walk"]   inline "Chill"            → the trip
 *   noService  ["No trains now", "Metrorail opens 5:00 AM"]             inline "No trains now"    → Data & Settings
 *   otherwise  ["Where to?"]                                            inline "Where to?"        → route options
 *
 * Above the tab bar the first line names what the bar is about — a saved trip's DESTINATION, whole (never the
 * free-text trip name, which can run to 60 characters) — and every line fits REGULAR_LINE_MAX_CHARS; inline,
 * every text fits INLINE_MAX_CHARS (ruling R1). A near trip's walk is the trip's ONE walk (mfix11, trip-walk.ts), in
 * the minutes its card shows: "~5 min walk" for a measured walk, "5 min walk" (no "~": Jamie's own number) for the
 * trip's own minutes. VoiceOver hears "an estimated 5-minute walk" ONLY for m7c's straight-line estimate, "a 5-minute
 * walk along streets" for Transitous's street-routed walk (mfix9) and "your 5-minute walk" for the trip's own minutes.
 * VoiceOver always hears the whole of it.
 */

/** Where a tap on the bar goes. */
export type StripTarget = { readonly kind: 'trip'; readonly tripId: string } | { readonly kind: 'plan' } | { readonly kind: 'settings' };

const NO_TRAINS_NOW = 'No trains now';
const WHERE_TO: NowText = Object.freeze({ lines: Object.freeze([copy.barWhereTo]), label: copy.barWhereToLabel });
const PLAN: StripTarget = Object.freeze({ kind: 'plan' });
const SETTINGS: StripTarget = Object.freeze({ kind: 'settings' });

/** The bar's words for a context, in a placement; `verdict` is the near trip's (useNearTripVerdict), else null. */
export function nowStripText(context: HomeContext, verdict: TripVerdict | null, placement: AccessoryPlacement): NowText {
  invariant(placement === 'regular' || placement === 'inline', `the strip has a known placement, got ${placement}`);
  let said: NowText;
  switch (context.kind) {
    case 'trip':
      said = tripText(context.trip, context.nowS, placement);
      break;
    case 'nearTrip':
      invariant(verdict !== null, 'a near trip is shown with its verdict');
      said = nearTripText(context.card, verdict, placement);
      break;
    case 'noService':
      said = noServiceText(context, placement);
      break;
    case 'station':
    case 'unknown':
      said = WHERE_TO;
      break;
  }
  invariant(fitsPlacement(said, placement), `"${said.lines.join(' / ')}" fits the ${placement} bar`);
  return said;
}

/** Where a tap goes: a trip (counting down or judged) opens that trip; no service, Data & Settings; otherwise route options. */
export function stripTarget(context: HomeContext): StripTarget {
  invariant(typeof context.kind === 'string', 'a home context has a kind');
  let target: StripTarget;
  if (context.kind === 'trip' || context.kind === 'nearTrip') {
    target = { kind: 'trip', tripId: context.kind === 'trip' ? context.trip.card.trip.id : context.card.trip.id };
  } else {
    target = context.kind === 'noService' ? SETTINGS : PLAN;
  }
  invariant(target.kind !== 'trip' || target.tripId.length > 0, 'a trip is opened by its id');
  return target;
}

/** A live countdown, for a trip the rider is not near: its destination over "Leave in 6 min"; inline, the countdown. */
export function tripText(trip: ActiveTrip, nowS: number, placement: AccessoryPlacement): NowText {
  invariant(trip.card.toName.length > 0, 'a saved trip has a destination');
  const hero = heroOf(trip.status, nowS);
  const inline = tripInline(hero.countdown.state, hero.countdown.minutesLeft, trip.status.current.leaveClock);
  const said = { lines: placement === 'inline' ? [inline] : [trip.card.toName, hero.text], label: `${hero.label} ${tripPhrase(trip.card)}. Opens the trip.` };
  invariant([...inline].length <= INLINE_MAX_CHARS, `the trip's inline text "${inline}" fits ${INLINE_MAX_CHARS} characters`);
  return said;
}

/**
 * A saved trip the rider is near: its destination over the verdict and the walk — the labelled short copy when the
 * line has room, else the verdict word ("Not worth it · ~5 min walk"); inline, the word alone.
 */
export function nearTripText(card: TripCardModel, judged: TripVerdict, placement: AccessoryPlacement): NowText {
  invariant(card.toName.length > 0 && card.fromName.length > 0, 'a saved trip names its stations');
  const minutes = judged.walk.minutes;
  const inline = hurryInline(judged.verdict, judged.ctx);
  const walk = judged.walk.source === 'override' ? `${minutes} min walk` : `~${minutes} min walk`;
  const status = [`${hurryShort(judged.verdict, judged.ctx)} · ${walk}`, `${inline} · ${walk}`].find((line) => [...line].length <= REGULAR_LINE_MAX_CHARS);
  invariant(status !== undefined, `some status line for ${judged.verdict.kind} fits ${REGULAR_LINE_MAX_CHARS} characters`);
  const label = `${hurrySentence(judged.verdict, judged.ctx)} ${tripPhrase(card)}, ${walkPhrase(minutes, judged.walk.source)}. Opens the trip.`;
  return { lines: placement === 'inline' ? [inline] : [card.toName, status], label };
}

/**
 * What VoiceOver hears of the walk: "an estimated 5-minute walk" ONLY for the straight-line estimate, "a 5-minute walk
 * along streets" for a routed one — "an" before a number said with a vowel first ("an 8-minute", "an 11-minute"; a
 * bar's walk is well under the 11,000 minutes where that rule would need more than the first digits) — and "your
 * 5-minute walk" for the trip's own minutes (mfix11).
 */
function walkPhrase(minutes: number, source: SavedTripWalk['source']): string {
  invariant(Number.isSafeInteger(minutes) && minutes >= 0 && minutes < 11_000, `a walk is a whole number of minutes, got ${minutes}`);
  const article = String(minutes).startsWith('8') || minutes === 11 || minutes === 18 ? 'an' : 'a';
  const phrase = { override: `your ${minutes}-minute walk`, routed: `${article} ${minutes}-minute walk along streets`, estimated: `an estimated ${minutes}-minute walk` }[source];
  invariant(phrase.includes('estimated') === (source === 'estimated') && phrase.startsWith('your') === (source === 'override'), 'only an estimated walk is called estimated, and only the trip\'s own minutes yours');
  return phrase;
}

/** "Trip to Bayfront Park from Brickell City Centre": what VoiceOver hears the bar is about. */
function tripPhrase(card: TripCardModel): string {
  const phrase = `Trip to ${card.toName} from ${card.fromName}`;
  invariant(card.trip.fromStationKey !== card.trip.toStationKey, 'a trip goes from one station to another');
  invariant(phrase.includes(card.toName) && phrase.includes(card.fromName), 'the phrase names both stations');
  return phrase;
}

/** The countdown in at most INLINE_MAX_CHARS characters. */
export function tripInline(state: CountdownState, minutesLeft: number, leaveClock: string): string {
  invariant(Number.isSafeInteger(minutesLeft) && minutesLeft >= 0, 'minutes left are whole');
  let text: string;
  switch (state) {
    case 'clock':
      text = `Leave ${leaveClock}`;
      break;
    case 'normal':
    case 'soon':
      text = minutesLeft < 10 ? copy.leaveIn(minutesLeft) : `Leave · ${minutesLeft} min`;
      break;
    case 'now':
      text = copy.leaveIn(0);
      break;
    case 'missed':
      text = 'Missed train';
      break;
  }
  invariant([...text].length <= INLINE_MAX_CHARS, `"${text}" fits ${INLINE_MAX_CHARS} characters`);
  return text;
}

/** Nothing runs: "No trains now" over "Metrorail opens 5:00 AM" (one line each, to fit); inline "No trains now". */
function noServiceText(context: Extract<HomeContext, { readonly kind: 'noService' }>, placement: AccessoryPlacement): NowText {
  const reopens = context.reopens === null ? null : `${MODE_NAMES[context.reopens.mode]} opens ${formatClockFromServiceSec(context.reopens.at.serviceSec)}`;
  const label = `No trains or Metromover cars run now.${reopens === null ? '' : ` ${reopens}.`} Opens Data & Settings.`;
  const lines = placement === 'inline' || reopens === null ? [NO_TRAINS_NOW] : [NO_TRAINS_NOW, reopens];
  invariant(lines[0] === NO_TRAINS_NOW, 'the bar says nothing runs');
  invariant(!label.includes('transfer'), 'no service is never a transfer');
  return { lines, label };
}
