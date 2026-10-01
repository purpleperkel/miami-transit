/**
 * SYNTHETIC Transitland departures responses: hand-written mapper edge cases (M4.3b), NOT a capture
 * and not generated. Synthetic trip ids ("fixture-…") and synthetic times, around stop ids and
 * names from the public static GTFS. The generated whole-response fixtures beside it
 * (synthetic-departures.ts, synthetic-vehicle-positions.ts) come from
 * scripts/fixtures/make-live-fixtures.ts. Why synthetic: the public-repo data rule (plan §3): no real
 * Transitland or Swiftly realtime content is ever committed; real captures stay in the gitignored
 * capture directory and are compared by structure only.
 *
 * CONFIRMED by the m8a probe's live captures (2026-10-01, structure only): the `stops[].departures[]`
 * envelope, stops[].stop_id and stop_name, trip.trip_id, trip.trip_headsign, trip.route.route_id and
 * route_short_name, departure.scheduled_local / estimated_local / estimated_utc, the
 * trip.schedule_relationship values 'SCHEDULED' and 'STATIC', and null estimates on a STATIC row.
 * Still ASSUMED from Transitland's REST v2 schema: the 'CANCELED' value (no live row has carried it yet).
 */

/** Government Center rail, northbound platform (stop 9513), Wednesday 2026-10-01 from 08:20 EDT. */
export const DEPARTURES_9513 = {
  stops: [
    {
      stop_id: '9513',
      stop_name: 'GOVERNMENT CTR.STAT.RAIL NORTHBOUND',
      departures: [
        {
          service_date: '2026-10-01',
          stop_sequence: 9,
          trip: {
            trip_id: 'fixture-rail-0828',
            trip_headsign: 'ORANGE LINE AIRPORT STATION',
            direction_id: 1,
            schedule_relationship: 'SCHEDULED',
            route: { route_id: '31009', route_short_name: '2600' },
          },
          departure: {
            scheduled_local: '2026-10-01T08:28:00-04:00',
            estimated_local: '2026-10-01T08:31:47-04:00',
            estimated_utc: '2026-10-01T12:31:47Z',
          },
        },
        {
          service_date: '2026-10-01',
          stop_sequence: 9,
          trip: {
            trip_id: 'fixture-rail-0834',
            trip_headsign: 'GREEN LINE PALMETTO STATION',
            direction_id: 1,
            schedule_relationship: 'SCHEDULED',
            route: { route_id: '31009', route_short_name: '2600' },
          },
          departure: {
            scheduled_local: '2026-10-01T08:34:00-04:00',
            estimated_local: '2026-10-01T08:35:02-04:00',
            estimated_utc: '2026-10-01T12:35:02Z',
          },
        },
        {
          service_date: '2026-10-01',
          stop_sequence: 9,
          trip: {
            trip_id: 'fixture-rail-0846',
            trip_headsign: 'ORANGE LINE AIRPORT STATION',
            direction_id: 1,
            schedule_relationship: 'STATIC',
            route: { route_id: '31009', route_short_name: '2600' },
          },
          departure: { scheduled_local: '2026-10-01T08:46:00-04:00', estimated_local: null, estimated_utc: null },
        },
        {
          service_date: '2026-10-01',
          stop_sequence: 9,
          trip: {
            trip_id: 'fixture-rail-0858',
            trip_headsign: 'GREEN LINE PALMETTO STATION',
            direction_id: 1,
            schedule_relationship: 'SCHEDULED',
            route: { route_id: '31009', route_short_name: '2600' },
          },
          departure: { scheduled_local: '2026-10-01T08:58:00-04:00', estimated_local: null, estimated_utc: null },
        },
        {
          service_date: '2026-10-01',
          stop_sequence: 9,
          trip: {
            trip_id: 'fixture-rail-0920',
            trip_headsign: 'ORANGE LINE AIRPORT STATION',
            direction_id: 1,
            schedule_relationship: 'CANCELED',
            route: { route_id: '31009', route_short_name: '2600' },
          },
          departure: { scheduled_local: '2026-10-01T09:20:00-04:00', estimated_local: null, estimated_utc: null },
        },
      ],
    },
  ],
};

/** Government Center Metromover (stop 813): one realtime Omni departure, one scheduled-only Inner Loop. */
export const DEPARTURES_813 = {
  stops: [
    {
      stop_id: '813',
      stop_name: 'GOVERNMENT CENTER METROMOVER STATION',
      departures: [
        {
          service_date: '2026-10-01',
          stop_sequence: 1,
          trip: {
            trip_id: 'fixture-omni-0831',
            trip_headsign: 'SCHOOL BOARD',
            direction_id: 1,
            schedule_relationship: 'SCHEDULED',
            route: { route_id: '14456' },
          },
          departure: {
            scheduled_local: '2026-10-01T08:31:00-04:00',
            estimated_local: '2026-10-01T08:30:40-04:00',
            estimated_utc: '2026-10-01T12:30:40Z',
          },
        },
        {
          service_date: '2026-10-01',
          stop_sequence: 1,
          trip: {
            trip_id: 'fixture-inner-0833',
            trip_headsign: 'INNER LOOP',
            direction_id: 0,
            schedule_relationship: 'STATIC',
            route: { route_id: '14457' },
          },
          departure: { scheduled_local: '2026-10-01T08:33:00-04:00', estimated_local: null, estimated_utc: null },
        },
      ],
    },
  ],
};
