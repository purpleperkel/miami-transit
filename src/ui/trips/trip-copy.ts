import { invariant } from '../../lib/invariant';
import { copy } from '../copy';
import { type Countdown, countdown } from './countdown';
import { TRIP_HORIZON_S, type TimedRide, type TripCardModel, type TripStatus, type TripWalk } from './trip-card';

/**
 * The trip card's words (plan §4 "Sheets": the hero "Leave in 6 min" and its states), built on M7.2's
 * countdown states (./countdown):
 *
 *   clock   "Leave at 8:14 AM"   more than an hour to go: a big minute count reads as noise
 *   normal  "Leave in 30 min"
 *   soon    "Leave in 4 min"     (orange on the card)
 *   now     "Leave now"          (one haptic and a VoiceOver announcement, useLeaveNowCue)
 *   missed  "Missed · next 8:26" (through leave-by's 30 s grace; then the next ride takes over)
 *
 * A card with no ride to count to says why — and at night it says there are no trains, never "transfer"
 * (m3a's input: nothing leaving is not a missing change of train).
 */

/** The trips' fixed words (kept here, beside the trips UI, rather than in the shared copy.ts). */
export const tripWords = Object.freeze({
  unavailable: 'Saved trips unavailable',
  addTrip: 'Add a trip',
  addTripHint: 'Chooses the stations and the walk of a new saved trip',
  saveTrip: 'Save trip',
  saveTripHint: 'Starts a saved trip from this station',
  routeOptions: 'Route options',
  routeOptionsHint: 'Shows route options from this trip’s station',
  directions: 'Directions to the station',
  directionsHint: 'Opens Apple Maps with directions to the station this trip leaves from',
  deleteTrip: 'Delete trip',
  deleteTripHint: 'Removes this saved trip and its reminders',
  cancel: 'Cancel',
  /** mfix7, the add-trip pickers: Leaving from with a location, and Going to's trailing group. */
  nearestFirst: 'Nearest first',
  needsTransfer: 'Needs a transfer',
  stationCount: (count: number) => (count === 1 ? '1 station' : `${count} stations`),
  showTransfersHint: 'Shows the stations a trip from here would need a transfer to reach',
  hideTransfersHint: 'Hides the stations that need a transfer',
  transferRouteOptionsHint: 'Shows route options from this station, which can plan a trip with a transfer',
});

export type Timed = Extract<TripStatus, { readonly kind: 'leave' }>;

export type Hero = {
  readonly countdown: Countdown;
  /** The hero line itself. */
  readonly text: string;
  /** The same, as a VoiceOver sentence. */
  readonly label: string;
};

/** The hero for a card counting to a ride, at `nowS`. */
export function heroOf(status: Timed, nowS: number): Hero {
  invariant(Number.isSafeInteger(nowS), 'the hero is read at a whole second');
  const left = countdown(status.current.leaveByEpoch, nowS);
  const text = heroText(left, status.current, status.next);
  const label = `${text}${left.state === 'missed' ? '' : ` to catch the ${status.current.departClock} train`}.`;
  invariant(text.length > 0 && label.startsWith(text), 'the hero is said the same to the eye and to VoiceOver');
  return { countdown: left, text, label };
}

function heroText(left: Countdown, current: TimedRide, next: TimedRide | null): string {
  invariant(current.leaveClock.length > 0, 'a ride has a leave-by clock');
  let text: string;
  switch (left.state) {
    case 'clock':
      text = `Leave at ${current.leaveClock}`;
      break;
    case 'normal':
    case 'soon':
    case 'now':
      text = copy.leaveIn(left.minutesLeft);
      break;
    case 'missed':
      text = next === null ? 'Missed · no later train soon' : `Missed · next ${next.departClock}`;
      break;
  }
  invariant(text.startsWith('Leave') || text.startsWith('Missed'), 'the hero says when to leave, or that it is too late');
  return text;
}

/** The line under the hero: the train it counts to, and the walk it allows for. */
export function rideLine(status: Timed, walk: TripWalk | null): string {
  invariant(status.current.departClock.length > 0, 'a ride has a departure clock');
  const walkPart = walk === null ? 'walk time unknown until the phone knows where you are' : walkText(walk);
  const line = `${status.current.departClock} train, arrives ${status.current.arriveClock} · ${walkPart}`;
  invariant(line.includes(status.current.departClock), 'the line names the train');
  return line;
}

function walkText(walk: TripWalk): string {
  invariant(walk.walkS >= 0, 'a walk is never negative');
  const minutes = Math.max(1, Math.round(walk.walkS / 60));
  const text = walk.source === 'here' ? `a ${minutes} min walk from here` : walk.source === 'start' ? `a ${minutes} min walk from your start` : `a ${minutes} min walk (your setting)`;
  invariant(text.includes(`${minutes} min`), 'the walk is said in minutes');
  return text;
}

export type Untimed = Exclude<TripStatus, { readonly kind: 'leave' }>;

/** Why a card has no ride to count to: a short title and one line of detail. */
export function untimedText(card: TripCardModel, status: Untimed): { readonly title: string; readonly detail: string } {
  invariant(card.status === status, 'the words are for this card');
  let said: { title: string; detail: string };
  switch (status.kind) {
    case 'no-service':
      said = { title: 'No trains now', detail: `Nothing leaves ${card.fromName} in the next ${TRIP_HORIZON_S / 3600} hours.` };
      break;
    case 'needs-transfer':
      said = { title: 'No direct ride now', detail: `Trains run, but none goes from ${card.fromName} to ${card.toName} without a transfer. Route options can plan it.` };
      break;
    case 'out-of-reach':
      said = { title: 'No train within reach', detail: `With ${card.walk === null ? 'the platform margin' : walkText(card.walk)}, no train in the next ${TRIP_HORIZON_S / 3600} hours can be made.` };
      break;
    case 'gap':
      said = { title: 'No timetable', detail: status.gap.kind === 'expired' ? copy.timetableExpired : copy.timetableNotStarted };
      break;
    case 'unknown-station':
      said = { title: copy.unknownStation, detail: copy.unknownStationMessage };
      break;
  }
  invariant(said.title.length > 0 && said.detail.length > 0, 'an untimed card says why');
  return said;
}
