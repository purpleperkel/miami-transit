import { invariant } from '../../lib/invariant';
import { MODE_NAMES } from '../a11y';
import { copy } from '../copy';
import { formatClockFromServiceSec } from '../format';
import { INLINE_MAX_CHARS } from '../hurry/copy';
import type { HurryReading } from '../hurry/hurry-reading';
import type { CountdownState } from '../trips/countdown';
import { heroOf } from '../trips/trip-copy';
import type { ActiveTrip, HomeContext } from './homeContext';
import { type AccessoryPlacement, nowAccessoryText, type NowText } from './now-text';

/**
 * What the Now strip says for the home context (M7.7): a live trip's countdown, no service, or — at a
 * station, near one, or with no position — m7c's hurry or chill for the nearest station (now-text.ts).
 * Inline (beside the minimized tab bar) every text fits INLINE_MAX_CHARS (ruling R1: 14 characters,
 * everywhere); VoiceOver always gets a full sentence.
 */

/** The strip's text for a context, in a placement; `reading` is the nearest station's hurry or chill. */
export function nowStripText(context: HomeContext, reading: HurryReading, placement: AccessoryPlacement): NowText {
  invariant(placement === 'regular' || placement === 'inline', `the strip has a known placement, got ${placement}`);
  let said: NowText;
  switch (context.kind) {
    case 'trip':
      said = tripText(context.trip, context.nowS, placement);
      break;
    case 'noService':
      said = noServiceText(context, placement);
      break;
    case 'station':
    case 'nearest':
    case 'unknown':
      said = nowAccessoryText(reading, placement);
      break;
  }
  invariant(placement === 'regular' || [...said.text].length <= INLINE_MAX_CHARS, `inline text "${said.text}" fits ${INLINE_MAX_CHARS} characters`);
  return said;
}

/** A live trip: "Leave in 6 min · Home → Work" above the tab bar, "Leave in 6 min" beside it. */
export function tripText(trip: ActiveTrip, nowS: number, placement: AccessoryPlacement): NowText {
  invariant(trip.card.trip.name.length > 0, 'a saved trip has a name');
  const hero = heroOf(trip.status, nowS);
  const inline = tripInline(hero.countdown.state, hero.countdown.minutesLeft, trip.status.current.leaveClock);
  const said = { text: placement === 'inline' ? inline : `${hero.text} · ${trip.card.trip.name}`, label: `${hero.label} Trip: ${trip.card.trip.name}. Opens the trip.` };
  invariant([...inline].length <= INLINE_MAX_CHARS, `the trip's inline text "${inline}" fits ${INLINE_MAX_CHARS} characters`);
  return said;
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

/** Nothing runs: "No trains now · Metrorail opens 5:00 AM"; inline "No trains now". */
function noServiceText(context: Extract<HomeContext, { readonly kind: 'noService' }>, placement: AccessoryPlacement): NowText {
  const reopens = context.reopens === null ? null : `${MODE_NAMES[context.reopens.mode]} opens ${formatClockFromServiceSec(context.reopens.at.serviceSec)}`;
  const regular = reopens === null ? 'No trains now' : `No trains now · ${reopens}`;
  const label = `No trains or Metromover cars run now.${reopens === null ? '' : ` ${reopens}.`} Opens Data & Settings.`;
  invariant(regular.startsWith('No trains now'), 'the strip says nothing runs');
  invariant(!label.includes('transfer'), 'no service is never a transfer');
  return { text: placement === 'inline' ? 'No trains now' : regular, label };
}
