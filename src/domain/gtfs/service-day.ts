import { invariant } from '../../lib/invariant';

/**
 * Plan §4 "On-device engine — Departures" (M3.2): which GTFS service days are running during an
 * instant or a window. Pure: the schedule repo fetches the candidate `service_day` rows, this
 * module decides.
 *
 * A service day's times count from its `base_epoch` (local noon minus 12 h, computed on the Mac by
 * the M2.14 calendar), and a trip timed 24:xx or later belongs to the PREVIOUS service day. So day d
 * may have trains running from `base_epoch(d)` until `base_epoch(d) + spanS`, where `spanS` is the
 * latest any trip ends (the real feed: 90240 s = 25:04). An instant is therefore covered by one
 * service day around midday and by two just after midnight — Friday's late trains still run at
 * Saturday 00:30. The phone never does time-zone math: every instant is an absolute epoch second.
 */

export type ServiceDay = {
  /** YYYYMMDD. */
  readonly date: number;
  /** The epoch second the day's GTFS times count from (local noon minus 12 h). */
  readonly baseEpoch: number;
};

/** An inclusive span of absolute epoch seconds; an instant is a window with fromEpoch === toEpoch. */
export type TimeWindow = { readonly fromEpoch: number; readonly toEpoch: number };

/** The calendar's first and last service days, and how long past its base a service day runs. */
export type ServiceCalendarBounds = {
  readonly first: ServiceDay;
  readonly last: ServiceDay;
  /** The latest trip end, in service-day seconds (max `trip.end_s`). */
  readonly spanS: number;
};

export type ServiceDayResolution =
  /** The service days with trains possibly running during the window, in date order. */
  | { readonly kind: 'active'; readonly days: readonly ServiceDay[] }
  /** The window starts after the last service day has run out: the schedule has expired. */
  | { readonly kind: 'expired'; readonly lastDate: number }
  /** The window ends before the first service day begins. */
  | { readonly kind: 'not-started'; readonly firstDate: number };

/** The one-instant window [epoch, epoch]. */
export function instantWindow(epoch: number): TimeWindow {
  invariant(Number.isSafeInteger(epoch), `an instant is a whole epoch second, got ${epoch}`);
  const window = { fromEpoch: epoch, toEpoch: epoch };
  invariant(isTimeWindow(window), 'an instant is a valid window');
  return window;
}

/** The window from `epoch` through `epoch + durationS`. */
export function windowFrom(epoch: number, durationS: number): TimeWindow {
  invariant(Number.isSafeInteger(epoch), `a window starts at a whole epoch second, got ${epoch}`);
  invariant(Number.isSafeInteger(durationS) && durationS >= 0, `a window lasts >= 0 whole seconds, got ${durationS}`);
  return { fromEpoch: epoch, toEpoch: epoch + durationS };
}

export function isTimeWindow(window: TimeWindow): boolean {
  invariant(typeof window === 'object' && window !== null, 'a window is an object');
  invariant('fromEpoch' in window && 'toEpoch' in window, 'a window has both ends');
  return Number.isSafeInteger(window.fromEpoch) && Number.isSafeInteger(window.toEpoch) && window.fromEpoch <= window.toEpoch;
}

/** Day `day` may have trains running during `window`: [base, base + spanS) meets [from, to]. */
export function runsDuring(day: ServiceDay, window: TimeWindow, spanS: number): boolean {
  invariant(isTimeWindow(window), 'runsDuring needs a valid window');
  invariant(Number.isSafeInteger(spanS) && spanS > 0, `a service day spans > 0 s, got ${spanS}`);
  return day.baseEpoch <= window.toEpoch && day.baseEpoch + spanS > window.fromEpoch;
}

/**
 * The service days running during `window`. `candidates` are `service_day` rows in date order
 * (any superset of the running days; the repo fetches by base-epoch range). No running day means
 * the window lies past the calendar's end (expired) or before its start (not-started); the
 * calendar is gapless (M2.14 expands every date), so a hole inside it is a broken contract.
 */
export function resolveServiceDays(
  window: TimeWindow,
  candidates: readonly ServiceDay[],
  bounds: ServiceCalendarBounds,
): ServiceDayResolution {
  invariant(isTimeWindow(window), 'resolveServiceDays needs a valid window');
  invariant(bounds.first.date <= bounds.last.date && bounds.first.baseEpoch <= bounds.last.baseEpoch, 'the calendar bounds are ordered');
  invariant(candidates.every((day, i) => i === 0 || candidates[i - 1]!.date < day.date), 'candidates come in strictly increasing date order');
  const days = candidates.filter((day) => runsDuring(day, window, bounds.spanS));
  if (days.length > 0) {
    return { kind: 'active', days };
  }
  if (window.fromEpoch >= bounds.last.baseEpoch + bounds.spanS) {
    return { kind: 'expired', lastDate: bounds.last.date };
  }
  invariant(
    window.toEpoch < bounds.first.baseEpoch,
    `no service day runs during ${window.fromEpoch}..${window.toEpoch}, yet it lies inside the calendar (${bounds.first.date}..${bounds.last.date})`,
  );
  return { kind: 'not-started', firstDate: bounds.first.date };
}
