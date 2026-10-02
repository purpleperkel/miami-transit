import { invariant } from '../../lib/invariant';
import { copy } from '../copy';
import { formatDistance } from '../format';
import { hurryCopy, hurryInline, hurrySentence, INLINE_MAX_CHARS } from '../hurry/copy';
import { type HurryReading, soonestBoard } from '../hurry/hurry-reading';

/**
 * What the Now strip — the tab bar's bottom accessory (ruling R2) — says, in each placement iOS gives it:
 * `regular` (the full-width bar above the tabs) and `inline` (beside the minimized tab bar, ruling R1: at
 * most INLINE_MAX_CHARS characters, everywhere). With a verdict it is the NEAREST station's hurry or chill
 * (hurry-reading.ts soonestBoard: the direction whose recommended train leaves first); without one it says
 * why in words. VoiceOver gets a full label either way. It never shows a feed hash.
 */

export type AccessoryPlacement = 'regular' | 'inline';

export type NowText = {
  readonly text: string;
  readonly label: string;
};

/** What a reading says: [regular text, inline text, VoiceOver label]. */
type Said = readonly [regular: string, inline: string, label: string];

/** What the accessory says for each reading without a verdict. */
const NO_VERDICT: Readonly<Record<'opening' | 'locating' | 'noLocation', Said>> = Object.freeze({
  opening: ['Opening the schedule…', 'Opening…', 'The schedule is opening. Opens Data & Settings.'],
  locating: ['Finding the nearest station…', 'Locating…', 'Finding the nearest station for hurry or chill. Opens Data & Settings.'],
  noLocation: ['Location off · hurry or chill needs it', 'Location off', 'Location is off, so hurry or chill cannot tell how far the station is. Opens Data & Settings.'],
});

export function nowAccessoryText(reading: HurryReading, placement: AccessoryPlacement): NowText {
  invariant(placement === 'regular' || placement === 'inline', `the accessory has a known placement, got ${placement}`);
  const [regular, inline, label] = choices(reading);
  const said = { text: placement === 'inline' ? inline : regular, label };
  invariant(placement === 'regular' || [...said.text].length <= INLINE_MAX_CHARS, `inline text "${said.text}" fits ${INLINE_MAX_CHARS} characters`);
  invariant(said.text.length > 0 && said.label.length > 0, 'the accessory always says something');
  return said;
}

/** What the accessory says for a reading. */
function choices(reading: HurryReading): Said {
  invariant(typeof reading.kind === 'string', 'a reading has a kind');
  const said = reading.kind === 'boards' ? verdictChoices(reading) : noVerdictChoices(reading);
  invariant(said.every((part) => part.length > 0), 'every part of what the accessory says is said');
  return said;
}

/** What the accessory says without a verdict, and why. */
function noVerdictChoices(reading: Exclude<HurryReading, { readonly kind: 'boards' }>): Said {
  invariant(typeof reading.kind === 'string', 'a reading has a kind');
  let said: Said;
  switch (reading.kind) {
    case 'opening':
      said = NO_VERDICT.opening;
      break;
    case 'locating':
      said = NO_VERDICT.locating;
      break;
    case 'no-location':
      said = NO_VERDICT.noLocation;
      break;
    case 'failed':
      said = ['Schedule unavailable · Settings', 'No schedule', `Schedule data unavailable: ${reading.message}. Opens Data & Settings.`];
      break;
    case 'far': {
      const distance = formatDistance(reading.walkMeters);
      said = [`Nearest station ${distance} away`, 'No stop nearby', `The nearest station, ${reading.stationName}, is ${distance} away. Opens Data & Settings.`];
      break;
    }
    case 'gap': {
      const why = reading.gap.kind === 'expired' ? copy.timetableExpired : copy.timetableNotStarted;
      said = [why, 'No timetable', `${why} Opens Data & Settings.`];
      break;
    }
  }
  invariant(said[2].endsWith('Opens Data & Settings.'), 'with no verdict, the accessory opens Data & Settings');
  return said;
}

/** The nearest station's verdict: the copy then the station in full, the inline verdict, and the sentence. */
function verdictChoices(reading: Extract<HurryReading, { readonly kind: 'boards' }>): Said {
  const board = soonestBoard(reading.boards);
  const where = board.title === null ? reading.stationName : `${reading.stationName}, ${board.title.charAt(0).toLowerCase()}${board.title.slice(1)}`;
  const label = `${hurrySentence(board.verdict, reading.ctx)} Nearest station: ${where}. Opens the station.`;
  invariant(reading.stationName.length > 0, 'the nearest station has a name');
  invariant(label.includes(reading.stationName), 'VoiceOver names the station');
  return [`${hurryCopy(board.verdict, reading.ctx)} · ${reading.stationName}`, hurryInline(board.verdict, reading.ctx), label];
}
