import type { HurryDeparture, HurryVerdict } from '../../domain/hurry/verdict';
import { invariant } from '../../lib/invariant';

/**
 * Plan M7c.2 / M7c.3: what a hurry-or-chill verdict SAYS, in four lengths:
 *
 *   hurryCopy      the station sheet's card         "Jog · makes the 2:14 with 1 min spare"
 *   hurryShort     the route chip and the Now bar   "Jog · 1 min spare" (mfix8)
 *   hurryInline    the Now bar beside the minimized tab bar: the verdict word alone, "Jog" — at most
 *                  INLINE_MAX_CHARS, always (mfix8)
 *   hurrySentence  VoiceOver: one full sentence that also says "live" or "scheduled", because the card's
 *                  accessibilityLabel replaces its Live / Scheduled badge
 *
 * mfix8 (Jamie, 2026-10-02: "it seems to say chill when the walk is 11 min and train leaves in 2"): EVERY
 * number on screen says what it counts — "3 min spare", "next in 3 min", "next 2:26" — so a spare time is never
 * read as the train's departure. Where there is no room for the label (inline) there is no number either.
 *
 * Minutes round DOWN (a rider is never promised time there is not); the engine's numbers stay unrounded.
 * The clock is injected (`ctx.clock` names a train "2:14"), so this module does no time-zone math: the app
 * formats from the schedule's own service-day bases (useHurryVerdict.ts).
 */

export type HurryCopyContext = {
  /** Now, epoch s: "next in 3 min" counts from it. */
  readonly now: number;
  /** An epoch as the short local clock, "2:14". */
  readonly clock: (epoch: number) => string;
};

/** Ruling R1: the Now strip's inline text is at most this many characters, for every verdict. */
export const INLINE_MAX_CHARS = 14;

const DOT = ' · ';

/** The words hurry-or-chill shows when it has no verdict to give (useHurryVerdict.ts HurryReading). */
export const HURRY_NOTES = Object.freeze({
  locating: 'Finding where you are for hurry or chill…',
  noLocation: 'Turn on location to see whether to hurry or chill.',
  far: (distance: string) => `You are ${distance} away, too far to hurry for a train.`,
  /** mfix7: the station sheet while its station's first live predictions are on their way (no verdict yet). */
  checking: 'Checking live times…',
});

/** The verdict a rider acts on: a MISSED verdict's nested one when a later train can be made, else itself. */
export function actionableVerdict(verdict: HurryVerdict): HurryVerdict {
  const acted = verdict.kind === 'MISSED' && verdict.nested !== null ? verdict.nested : verdict;
  invariant(acted.kind !== 'MISSED' || acted.nested === null, 'a rider acts on a train that can be made, or on none');
  invariant(acted === verdict || verdict.kind === 'MISSED', 'only a MISSED verdict defers to its nested one');
  return acted;
}

/** The copy in two parts: the hero's word(s) and the rest ("Jog" + "makes the 2:14 with 1 min spare"). */
export type HurryParts = { readonly headline: string; readonly detail: string | null };

export function hurryParts(verdict: HurryVerdict, ctx: HurryCopyContext): HurryParts {
  invariant(Number.isFinite(ctx.now) && typeof ctx.clock === 'function', 'copy is read at an instant, with a clock');
  let parts: HurryParts;
  switch (verdict.kind) {
    case 'CHILL':
      parts = { headline: 'Chill', detail: `${minutesText(spareOf(verdict))} to spare` };
      break;
    case 'JOG':
      parts = { headline: 'Jog', detail: `makes the ${ctx.clock(departureOf(verdict).epoch)} with ${minutesText(spareOf(verdict))} spare` };
      break;
    case 'NOT_WORTH_IT':
      parts = { headline: 'Not worth it', detail: `next in ${minutesText(nextOf(verdict).epoch - ctx.now)}` };
      break;
    case 'MISSED':
      parts = { headline: 'Missed', detail: verdict.nested === null ? 'nothing you can make soon' : `next ${ctx.clock(departureOf(verdict.nested).epoch)}${DOT}${nestedWord(verdict.nested)}` };
      break;
    case 'NO_SERVICE':
      parts = { headline: 'No more trains tonight', detail: null };
      break;
  }
  invariant(parts.headline.length > 0 && parts.detail !== '', 'the copy always says something, and never an empty detail');
  return parts;
}

/** The plan's copy (M7c.2), e.g. "Chill · 3 min to spare". */
export function hurryCopy(verdict: HurryVerdict, ctx: HurryCopyContext): string {
  const { headline, detail } = hurryParts(verdict, ctx);
  const text = detail === null ? headline : `${headline}${DOT}${detail}`;
  invariant(text.startsWith(headline), 'the copy leads with the verdict');
  invariant(!/[A-Za-z]\.$/.test(text), 'the copy is a label, not a sentence');
  return text;
}

/**
 * The short copy (mfix8): the route options' hurry chip and the Now bar's status line. Every number is
 * labelled — "Chill · 3 min spare", "Jog · 1 min spare", "Not worth it · next in 3 min", "Missed · next 2:26",
 * "Missed · nothing soon", "No more trains tonight" — never a bare "Chill · 2 min".
 */
export function hurryShort(verdict: HurryVerdict, ctx: HurryCopyContext): string {
  invariant(Number.isFinite(ctx.now) && typeof ctx.clock === 'function', 'short copy is read at an instant, with a clock');
  let text: string;
  switch (verdict.kind) {
    case 'CHILL':
    case 'JOG':
      text = `${inlineWord(verdict)}${DOT}${minutesText(spareOf(verdict))} spare`;
      break;
    case 'NOT_WORTH_IT':
      text = `Not worth it${DOT}next in ${minutesText(nextOf(verdict).epoch - ctx.now)}`;
      break;
    case 'MISSED':
      text = verdict.nested === null ? `Missed${DOT}nothing soon` : `Missed${DOT}next ${ctx.clock(departureOf(verdict.nested).epoch)}`;
      break;
    case 'NO_SERVICE':
      text = 'No more trains tonight';
      break;
  }
  invariant(text.startsWith(hurryParts(verdict, ctx).headline), 'the short copy leads with the verdict');
  invariant(!/\d$/.test(text) || /\d:\d\d$/.test(text), `"${text}" ends in a label or a clock time, never a bare number`);
  return text;
}

/**
 * The Now bar's inline text (ruling R1: at most INLINE_MAX_CHARS characters, beside the minimized tab
 * bar): the verdict word alone — "Chill", "Jog", "Not worth it" — with no room for a number's label, so no
 * number (mfix8). A MISSED verdict names the train that can still be made ("Next 2:26"), else "Missed".
 */
export function hurryInline(verdict: HurryVerdict, ctx: HurryCopyContext): string {
  invariant(Number.isFinite(ctx.now), 'inline copy is read at an instant');
  let text: string;
  if (verdict.kind === 'MISSED') {
    text = verdict.nested === null ? 'Missed' : `Next ${ctx.clock(departureOf(verdict.nested).epoch)}`;
  } else if (verdict.kind === 'NO_SERVICE') {
    text = 'No more trains';
  } else {
    text = inlineWord(verdict);
  }
  invariant([...text].length <= INLINE_MAX_CHARS, `inline text "${text}" fits ${INLINE_MAX_CHARS} characters`);
  invariant(text.trim().length > 0, 'the inline text says something');
  return text;
}

/**
 * The VoiceOver label (M7c.2): one full sentence, saying whether the train it is about runs on a live
 * prediction or the timetable — the card's badge is hidden behind this label.
 */
export function hurrySentence(verdict: HurryVerdict, ctx: HurryCopyContext): string {
  invariant(Number.isFinite(ctx.now), 'a sentence is read at an instant');
  const source = `going by ${actionableVerdict(verdict).live ? 'live' : 'scheduled'} times`;
  let sentence: string;
  if (verdict.kind === 'NO_SERVICE') {
    sentence = 'No more trains are scheduled tonight.';
  } else if (verdict.kind === 'MISSED') {
    sentence = `You will miss the ${ctx.clock(departureOf(verdict).epoch)} train, ${missedClause(verdict.nested, ctx)}, ${source}.`;
  } else {
    sentence = `${madeClause(verdict, ctx)}, ${source}.`;
  }
  invariant(/^[A-Z][^·]*\.$/.test(sentence) && sentence.split(/\s+/).length >= 4, `"${sentence}" is one full sentence`);
  return sentence;
}

/** CHILL, JOG or NOT_WORTH_IT as the start of a sentence. */
function madeClause(verdict: HurryVerdict, ctx: HurryCopyContext): string {
  const train = `the ${ctx.clock(departureOf(verdict).epoch)} train`;
  invariant(verdict.kind === 'CHILL' || verdict.kind === 'JOG' || verdict.kind === 'NOT_WORTH_IT', `${verdict.kind} is a train that can be made`);
  if (verdict.kind === 'NOT_WORTH_IT') {
    return `Not worth hurrying for ${train}, another leaves in ${minutesWords(nextOf(verdict).epoch - ctx.now)}`;
  }
  const spare = minutesWords(spareOf(verdict));
  invariant(spare.length > 0, 'a made train says its spare time');
  return verdict.kind === 'CHILL' ? `Chill, a walk makes ${train} with ${spare} to spare` : `Jog to make ${train} with ${spare} to spare`;
}

/** What a MISSED sentence says about the train after it. */
function missedClause(nested: HurryVerdict | null, ctx: HurryCopyContext): string {
  invariant(nested === null || nested.kind !== 'MISSED', 'a nested verdict is about a train that can be made');
  if (nested === null) {
    return 'and none of the trains right after it can be reached in time';
  }
  const train = `the ${ctx.clock(departureOf(nested).epoch)} train`;
  invariant(train.length > 10, 'the next train is named by its time');
  if (nested.kind === 'NOT_WORTH_IT') {
    return `and ${train} is not worth hurrying for, another follows soon after`;
  }
  const spare = minutesWords(spareOf(nested));
  return nested.kind === 'CHILL' ? `but a walk makes ${train} with ${spare} to spare` : `but a jog makes ${train} with ${spare} to spare`;
}

/** The lower-case word for a nested verdict in "Missed · next 2:26 · chill". */
function nestedWord(nested: HurryVerdict): string {
  invariant(nested.kind === 'CHILL' || nested.kind === 'JOG' || nested.kind === 'NOT_WORTH_IT', `a nested verdict is a train that can be made, got ${nested.kind}`);
  const word = nested.kind === 'CHILL' ? 'chill' : nested.kind === 'JOG' ? 'jog' : 'not worth it';
  invariant(word === word.toLowerCase(), 'the nested word is lower case');
  return word;
}

/** The verdict word, as the inline and short copy say it. */
function inlineWord(verdict: HurryVerdict): string {
  invariant(verdict.kind !== 'MISSED' && verdict.kind !== 'NO_SERVICE', `${verdict.kind} has no inline verdict word`);
  const word = verdict.kind === 'CHILL' ? 'Chill' : verdict.kind === 'JOG' ? 'Jog' : 'Not worth it';
  invariant([...word].length <= INLINE_MAX_CHARS, 'a verdict word fits inline on its own');
  return word;
}

/** Whole minutes, rounded down: "3 min", or "under 1 min" below a minute. */
function minutesText(seconds: number): string {
  invariant(Number.isFinite(seconds) && seconds >= 0, `a span of time is a non-negative number of seconds, got ${seconds}`);
  const minutes = Math.floor(seconds / 60);
  const text = minutes < 1 ? 'under 1 min' : `${minutes} min`;
  invariant(text.endsWith(' min'), 'minutes read "<n> min"');
  return text;
}

/** Whole minutes in words for VoiceOver: "1 minute", "3 minutes", or "less than a minute". */
function minutesWords(seconds: number): string {
  invariant(Number.isFinite(seconds) && seconds >= 0, `a span of time is a non-negative number of seconds, got ${seconds}`);
  const minutes = Math.floor(seconds / 60);
  const words = minutes < 1 ? 'less than a minute' : minutes === 1 ? '1 minute' : `${minutes} minutes`;
  invariant(words.includes('minute'), 'a span is said in minutes');
  return words;
}

function departureOf(verdict: HurryVerdict): HurryDeparture {
  const departure = verdict.departure;
  invariant(departure !== null, `a ${verdict.kind} verdict is about a departure`);
  invariant(Number.isFinite(departure.epoch), 'a departure leaves at an instant');
  return departure;
}

function nextOf(verdict: HurryVerdict): HurryDeparture {
  const next = verdict.next;
  invariant(verdict.kind === 'NOT_WORTH_IT', `only NOT_WORTH_IT points at a next train, got ${verdict.kind}`);
  invariant(next !== null, 'NOT_WORTH_IT points at the next train');
  return next;
}

function spareOf(verdict: HurryVerdict): number {
  const spare = verdict.spareS;
  invariant(verdict.kind === 'CHILL' || verdict.kind === 'JOG', `only CHILL and JOG have spare time, got ${verdict.kind}`);
  invariant(spare !== null && spare >= 0, `${verdict.kind} carries its spare seconds`);
  return spare;
}
