/**
 * Transitland departures responses (M4.3b), hand-shaped and sanitized — no key, synthetic trip ids —
 * after the live probe of 2026-10-01 (`GET /api/v2/rest/stops/f-dhw-miamidadetransit:<stop_id>/departures?next=3600`).
 *
 * Field names CONFIRMED by that probe (arbiter note R-d): trip.schedule_relationship ('SCHEDULED'),
 * trip.trip_headsign ('ORANGE LINE AIRPORT STATION'), trip.route.route_short_name ('2600'), and
 * departure.scheduled_local / estimated_local / estimated_utc for stop 9513 (Orange due 08:28,
 * estimated 08:35:29).
 * ASSUMED from Transitland's REST v2 schema, to be confirmed by the captured fixture (plan M8.3):
 * the `stops[].departures[]` envelope, stops[].stop_id, trip.trip_id, trip.route.route_id, the
 * 'STATIC' and 'CANCELED' relationship values, and null for a missing estimate.
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
            estimated_local: '2026-10-01T08:35:29-04:00',
            estimated_utc: '2026-10-01T12:35:29Z',
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
            estimated_local: '2026-10-01T08:36:10-04:00',
            estimated_utc: '2026-10-01T12:36:10Z',
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
