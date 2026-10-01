import { strToU8, zipSync } from 'fflate';

import { invariant } from '../../../src/lib/invariant';

/**
 * M2.4: the synthetic mini feed every GTFS pipeline test runs on — a few real trips, not 970k rows.
 *
 * Every data row except shapes.txt is copied VERBATIM from the county feed (published 2026-07-31,
 * 8,419,295 bytes), so the real parsing quirks are in the bytes: CRLF line endings, a space before
 * unpadded single-digit hours (" 5:15:00"), and times past 24:00 ("25:04:00"). The headers are the
 * real headers, column for column. Two deliberate departures, both named:
 *  - stops.txt starts with a UTF-8 BOM. Today's feed has none, but a re-export can add one, and
 *    plan §4 step 4 requires BOM tolerance end to end.
 *  - shapes.txt is generated: each shape runs through the platforms of the first trip that uses it
 *    (the real shapes are 4 MB). stop_times' shape_dist_traveled values still describe the REAL
 *    shapes; the pipeline never reads that column (it projects stops onto shapes itself, step 9).
 *
 * What it contains (plan M2.4), and why:
 *  - Metrorail 31009: a Green pattern (Palmetto ↔ Dadeland South, both directions), an Orange
 *    pattern (MIA → Dadeland South), 2-stop MIA ↔ Earlington Heights shuttles, and the Green
 *    pattern under both spellings of the misleading single-track headsign.
 *  - Metromover: Inner Loop 14457 half-trips chained by one block_id, and both MMO 14456 legs
 *    (Omni and Brickell share the route_id and differ by shape).
 *  - Out of scope, for load-feed to drop: bus 301 (31161, with the real pickup_type=1 row) and the
 *    MIA airport mover 14458.
 *  - calendar_dates.txt: the real Labor Day 20260907 swap (weekday service off, Sunday service on).
 *  - Sunday service 8 runs on 20261101, the day daylight saving time ends.
 */

export const MINI_FEED_FILES = [
  'agency.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'routes.txt',
  'shapes.txt',
  'stop_times.txt',
  'stops.txt',
  'trips.txt',
] as const;
export type MiniFeedFile = (typeof MINI_FEED_FILES)[number];
/** Per-file replacement text; `null` leaves the file out of the zip. */
export type MiniFeedOverrides = Partial<Record<MiniFeedFile, string | null>>;

/** The ids and dates the tests (this card's and later ones) ask the fixture about. */
export const MINI_FEED_FACTS = {
  railRoute: '31009',
  innerLoopRoute: '14457',
  omniBrickellRoute: '14456',
  airportMoverRoute: '14458',
  busRoute: '31161',
  greenTrip: '6283551',
  orangeTrip: '6283523',
  shuttleTrips: ['6283526', '6283699', '6284241'],
  singleTrackTrips: { 'AFTER 8PM': '6283569', 'AFTER 8 PM': '6284051' },
  innerLoopBlock: '1403245',
  innerLoopHalfTrips: ['4832840', '4832382', '4832845'],
  omniTrip: '4828771',
  brickellTrip: '4828981',
  airportMoverTrip: '4831451',
  busTrip: '6322448',
  weekdayRailService: '6',
  saturdayRailService: '7',
  sundayRailService: '8',
  weekdayMoverService: '11',
  laborDay: 20260907,
  dstEndDate: 20261101,
  /** The real county feed's agency_timezone. */
  timeZone: 'America/New_York',
} as const;

/** Stations by their real platform stop_ids (S = southbound, N = northbound). */
export const MINI_FEED_STOPS = {
  palmettoS: '9486',
  palmettoN: '9487',
  earlingtonHeightsS: '9500',
  earlingtonHeightsN: '9501',
  dadelandSouthS: '9528',
  dadelandSouthN: '9529',
  miaS: '10494',
  miaN: '10495',
  moverGovernmentCenter: '813',
} as const;

const CRLF = '\r\n';
const BOM = '\uFEFF';
/**
 * The real zip's Last-Modified. A fixed time keeps the fixture zip byte-identical across runs; fflate
 * stamps entries with local-time fields, so the bytes are stable per machine time zone.
 */
const ZIP_MTIME = '2026-07-31T20:10:53Z';

const HEADERS = {
  agency: 'agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url',
  calendar: 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  calendarDates: 'service_id,date,exception_type',
  routes: 'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color',
  shapes: 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled',
  stopTimes:
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint',
  stops:
    'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,stop_timezone,wheelchair_boarding',
  trips:
    'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed',
} as const;

const AGENCY_ROWS = ['DTPW305,Miami-Dade Transit,http://www.miamidade.gov/transit,America/New_York,en,,'];

const ROUTE_ROWS = [
  '31009,DTPW305,2600,REGULAR METRORAIL SERVICE,,2,,FF8040,',
  '31161,DTPW305,301,DADE/MONROE EXPRESS,,3,,804000,FFFFFF',
  '14458,DTPW305,MIA,AIRPORT PEOPLE MOVER,,0,,008080,FFFFFF',
  '14457,DTPW305,MMI,METROMOVER INNER LOOP,,0,,FF8000,FFFFFF',
  '14456,DTPW305,MMO,METROMOVER OMNI/BRICKELL OUTER LOOP,,0,,008000,FFFFFF',
];

/** Bus weekday 1 and Sunday 3; rail weekday 6, Saturday 7, Sunday 8; mover weekday 11, Saturday 12. */
const CALENDAR_ROWS = [
  '1,1,1,1,1,1,0,0,20260720,20261122',
  '3,0,0,0,0,0,0,1,20260720,20261122',
  '6,1,1,1,1,1,0,0,20260803,20261122',
  '7,0,0,0,0,0,1,0,20260803,20261122',
  '8,0,0,0,0,0,0,1,20260803,20261122',
  '11,1,1,1,1,1,0,0,20231113,20261231',
  '12,0,0,0,0,0,1,0,20231113,20261231',
];

/** Labor Day, Monday 20260907, runs Sunday service: weekday off (2), Sunday on (1), bus and rail. */
const CALENDAR_DATE_ROWS = ['3,20260907,1', '1,20260907,2', '8,20260907,1', '6,20260907,2'];

const TRIP_ROWS = [
  '31009,6,6283551,GREEN LINE DADELAND SOUTH,,0,1603603,211239,2,2',
  '31009,6,6283523,ORANGE LINE DADELAND SOUTH,,0,1603595,211236,2,2',
  '31009,6,6283526,EARLINGTON HEIGHTS,,0,1603596,211235,2,2',
  '31009,6,6283699,ORANGE LINE AIRPORT STATION,,1,1603597,211250,2,2',
  '31009,6,6283569,EHT - CUL SINGLE TRACK AFTER 8PM,,0,1603598,211246,2,2',
  '31009,7,6284051,EHT - CUL SINGLE TRACK AFTER 8 PM,,1,1603610,211263,2,2',
  '31009,8,6284241,EARLINGTON HEIGHTS,,0,1603622,211235,2,2',
  '14457,11,4832840,INNER LOOP,,0,1403245,123750,2,2',
  '14457,11,4832382,INNER LOOP,,1,1403245,123751,2,2',
  '14457,11,4832845,INNER LOOP,,0,1403245,123750,2,2',
  '14456,11,4828771,DOWNTOWN,,0,1403221,123745,2,2',
  '14456,11,4828981,DOWNTOWN,,0,1403223,123746,2,2',
  '14458,12,4831451,MIAMI INTERNATIONAL AIRPORT STATION,,0,1403243,123752,2,2',
  '31161,1,6322448,301 - FL CITY SW 344 ST PARK & RIDE,,1,1608213,212037,2,2',
];

const STOP_TIME_ROWS = [
  // Green, weekday: Palmetto → Dadeland South (22 stops)
  '6283551, 5:15:00, 5:15:00,9486,1,,0,0,,1',
  '6283551, 5:18:00, 5:18:00,9488,2,,0,0,2.2435,1',
  '6283551, 5:21:00, 5:21:00,9490,3,,0,0,4.5423,1',
  '6283551, 5:24:00, 5:24:00,9492,4,,0,0,6.6494,1',
  '6283551, 5:26:00, 5:26:00,9494,5,,0,0,7.7407,1',
  '6283551, 5:29:00, 5:29:00,9496,6,,0,0,9.7844,1',
  '6283551, 5:31:00, 5:31:00,9498,7,,0,0,10.9233,1',
  '6283551, 5:34:00, 5:34:00,9500,8,,0,0,12.8996,1',
  '6283551, 5:36:00, 5:36:00,9502,9,,0,0,14.6702,1',
  '6283551, 5:38:00, 5:38:00,9504,10,,0,0,16.0875,1',
  '6283551, 5:39:00, 5:39:00,9506,11,,0,0,16.7560,1',
  '6283551, 5:41:00, 5:41:00,9508,12,,0,0,17.8754,1',
  '6283551, 5:43:00, 5:43:00,9510,13,,0,0,19.2975,1',
  '6283551, 5:45:00, 5:45:00,9512,14,,0,0,19.8421,1',
  '6283551, 5:47:00, 5:47:00,9514,15,,0,0,21.1841,1',
  '6283551, 5:50:00, 5:50:00,9516,16,,0,0,23.5688,1',
  '6283551, 5:53:00, 5:53:00,9518,17,,0,0,26.5245,1',
  '6283551, 5:55:00, 5:55:00,9520,18,,0,0,28.3291,1',
  '6283551, 5:58:00, 5:58:00,9522,19,,0,0,31.3250,1',
  '6283551, 6:00:00, 6:00:00,9524,20,,0,0,32.9411,1',
  '6283551, 6:02:00, 6:02:00,9526,21,,0,0,35.1223,1',
  '6283551, 6:04:00, 6:04:00,9528,22,,0,0,36.2172,1',
  // Orange, weekday: MIA → Dadeland South (16 stops)
  '6283523, 5:22:00, 5:22:00,10494,1,,0,0,,1',
  '6283523, 5:26:00, 5:26:00,9500,2,,0,0,4.2063,1',
  '6283523, 5:28:00, 5:28:00,9502,3,,0,0,5.9798,1',
  '6283523, 5:30:00, 5:30:00,9504,4,,0,0,7.3962,1',
  '6283523, 5:31:00, 5:31:00,9506,5,,0,0,8.0677,1',
  '6283523, 5:33:00, 5:33:00,9508,6,,0,0,9.1821,1',
  '6283523, 5:35:00, 5:35:00,9510,7,,0,0,10.6052,1',
  '6283523, 5:37:00, 5:37:00,9512,8,,0,0,11.1498,1',
  '6283523, 5:39:00, 5:39:00,9514,9,,0,0,12.4927,1',
  '6283523, 5:42:00, 5:42:00,9516,10,,0,0,14.8754,1',
  '6283523, 5:45:00, 5:45:00,9518,11,,0,0,17.8267,1',
  '6283523, 5:47:00, 5:47:00,9520,12,,0,0,19.6315,1',
  '6283523, 5:50:00, 5:50:00,9522,13,,0,0,22.6217,1',
  '6283523, 5:52:00, 5:52:00,9524,14,,0,0,24.2584,1',
  '6283523, 5:54:00, 5:54:00,9526,15,,0,0,26.4197,1',
  '6283523, 5:56:00, 5:56:00,9528,16,,0,0,27.5239,1',
  // shuttle, weekday: MIA → Earlington Heights (2 stops)
  '6283526,22:17:00,22:17:00,10494,1,,0,0,,1',
  '6283526,22:21:00,22:21:00,9500,2,,0,0,4.2143,1',
  // shuttle, weekday: Earlington Heights → MIA (2 stops)
  '6283699,22:44:00,22:44:00,9501,1,,0,0,,1',
  '6283699,22:48:00,22:48:00,10495,2,,0,0,4.2043,1',
  // Green pattern under the single-track headsign "…AFTER 8PM", weekday, 24:00:00 → 25:04:00
  '6283569,24:00:00,24:00:00,9486,1,,0,0,,1',
  '6283569,24:04:00,24:04:00,9488,2,,0,0,2.2435,1',
  '6283569,24:07:00,24:07:00,9490,3,,0,0,4.5423,1',
  '6283569,24:10:00,24:10:00,9492,4,,0,0,6.6494,1',
  '6283569,24:12:00,24:12:00,9494,5,,0,0,7.7407,1',
  '6283569,24:15:00,24:15:00,9496,6,,0,0,9.7844,1',
  '6283569,24:18:00,24:18:00,9498,7,,0,0,10.9233,1',
  '6283569,24:26:00,24:26:00,9500,8,,0,0,12.8996,1',
  '6283569,24:28:00,24:28:00,9502,9,,0,0,14.6702,1',
  '6283569,24:30:00,24:30:00,9504,10,,0,0,16.0875,1',
  '6283569,24:33:00,24:33:00,9506,11,,0,0,16.7560,1',
  '6283569,24:36:00,24:36:00,9508,12,,0,0,17.8754,1',
  '6283569,24:41:00,24:41:00,9510,13,,0,0,19.2975,1',
  '6283569,24:44:00,24:44:00,9512,14,,0,0,19.8421,1',
  '6283569,24:47:00,24:47:00,9514,15,,0,0,21.1841,1',
  '6283569,24:50:00,24:50:00,9516,16,,0,0,23.5688,1',
  '6283569,24:53:00,24:53:00,9518,17,,0,0,26.5245,1',
  '6283569,24:55:00,24:55:00,9520,18,,0,0,28.3291,1',
  '6283569,24:58:00,24:58:00,9522,19,,0,0,31.3250,1',
  '6283569,25:00:00,25:00:00,9524,20,,0,0,32.9411,1',
  '6283569,25:02:00,25:02:00,9526,21,,0,0,35.1223,1',
  '6283569,25:04:00,25:04:00,9528,22,,0,0,36.2172,1',
  // Green pattern under "…AFTER 8 PM", Saturday night, 24:00:00 → 24:51:00
  '6284051,24:00:00,24:00:00,9529,1,,0,0,,1',
  '6284051,24:02:00,24:02:00,9527,2,,0,0,1.0963,1',
  '6284051,24:04:00,24:04:00,9525,3,,0,0,3.2769,1',
  '6284051,24:06:00,24:06:00,9523,4,,0,0,4.8937,1',
  '6284051,24:09:00,24:09:00,9521,5,,0,0,7.8889,1',
  '6284051,24:11:00,24:11:00,9519,6,,0,0,9.6950,1',
  '6284051,24:14:00,24:14:00,9517,7,,0,0,12.6484,1',
  '6284051,24:17:00,24:17:00,9515,8,,0,0,15.0301,1',
  '6284051,24:19:00,24:19:00,9513,9,,0,0,16.3750,1',
  '6284051,24:20:00,24:20:00,9511,10,,0,0,16.9177,1',
  '6284051,24:23:00,24:23:00,9509,11,,0,0,18.3449,1',
  '6284051,24:25:00,24:25:00,9507,12,,0,0,19.4602,1',
  '6284051,24:26:00,24:26:00,9505,13,,0,0,20.1287,1',
  '6284051,24:28:00,24:28:00,9503,14,,0,0,21.5461,1',
  '6284051,24:31:00,24:31:00,9501,15,,0,0,23.3166,1',
  '6284051,24:34:00,24:34:00,9499,16,,0,0,25.2939,1',
  '6284051,24:36:00,24:36:00,9497,17,,0,0,26.4318,1',
  '6284051,24:39:00,24:39:00,9495,18,,0,0,28.4765,1',
  '6284051,24:41:00,24:41:00,9493,19,,0,0,29.5668,1',
  '6284051,24:43:00,24:43:00,9491,20,,0,0,31.6749,1',
  '6284051,24:46:00,24:46:00,9489,21,,0,0,33.9747,1',
  '6284051,24:51:00,24:51:00,9487,22,,0,0,36.2172,1',
  // shuttle, Sunday (runs on the DST date 20261101)
  '6284241, 5:11:00, 5:11:00,10494,1,,0,0,,1',
  '6284241, 5:15:00, 5:15:00,9500,2,,0,0,4.2143,1',
  // Inner Loop half-trip A, block 1403245: Bayfront Park (832) → Government Center (813)
  '4832840,10:02:30,10:02:30,832,1,,0,0,,1',
  '4832840,10:04:00,10:04:00,833,2,,0,0,0.5443,1',
  '4832840,10:05:30,10:05:30,834,3,,0,0,0.9044,1',
  '4832840,10:07:30,10:07:30,813,4,,0,0,1.4058,1',
  // Inner Loop half-trip B, same block: Government Center (813) → Bayfront Park (841)
  '4832382,10:07:30,10:07:30,813,1,,0,0,,1',
  '4832382,10:08:30,10:08:30,837,2,,0,0,0.3858,1',
  '4832382,10:09:30,10:09:30,838,3,,0,0,0.7157,1',
  '4832382,10:10:30,10:10:30,839,4,,0,0,1.0636,1',
  '4832382,10:12:30,10:12:30,840,5,,0,0,1.2668,1',
  '4832382,10:13:30,10:13:30,841,6,,0,0,1.7727,1',
  // Inner Loop half-trip A again, same block
  '4832845,10:15:00,10:15:00,832,1,,0,0,,1',
  '4832845,10:16:30,10:16:30,833,2,,0,0,0.5443,1',
  '4832845,10:18:00,10:18:00,834,3,,0,0,0.9044,1',
  '4832845,10:20:00,10:20:00,813,4,,0,0,1.4058,1',
  // MMO Omni leg (shape 123745): School Board → Government Center
  '4828771, 5:32:00, 5:32:00,795,1,,0,0,,1',
  '4828771, 5:33:00, 5:33:00,796,2,,0,0,0.5206,1',
  '4828771, 5:34:00, 5:34:00,797,3,,0,0,1.1206,1',
  '4828771, 5:35:00, 5:35:00,798,4,,0,0,1.4817,1',
  '4828771, 5:36:00, 5:36:00,799,5,,0,0,1.7449,1',
  '4828771, 5:37:00, 5:37:00,800,6,,0,0,1.9572,1',
  '4828771, 5:38:00, 5:38:00,811,7,,0,0,2.2790,1',
  '4828771, 5:39:00, 5:39:00,812,8,,0,0,2.6090,1',
  '4828771, 5:40:00, 5:40:00,813,9,,0,0,2.9948,1',
  // MMO Brickell leg (shape 123746): Financial District → Government Center
  '4828981, 5:30:00, 5:30:00,801,1,,0,0,,1',
  '4828981, 5:31:00, 5:31:00,802,2,,0,0,0.4492,1',
  '4828981, 5:32:00, 5:32:00,803,3,,0,0,0.8252,1',
  '4828981, 5:33:00, 5:33:00,804,4,,0,0,1.1474,1',
  '4828981, 5:34:00, 5:34:00,805,5,,0,0,1.3980,1',
  '4828981, 5:35:00, 5:35:00,806,6,,0,0,1.6088,1',
  '4828981, 5:36:00, 5:36:00,807,7,,0,0,1.8100,1',
  '4828981, 5:37:00, 5:37:00,808,8,,0,0,2.3526,1',
  '4828981, 5:38:00, 5:38:00,809,9,,0,0,2.8585,1',
  '4828981, 5:39:00, 5:39:00,810,10,,0,0,3.0618,1',
  '4828981, 5:40:00, 5:40:00,811,11,,0,0,3.4096,1',
  '4828981, 5:41:00, 5:41:00,812,12,,0,0,3.7395,1',
  '4828981, 5:42:00, 5:42:00,813,13,,0,0,4.1254,1',
  // MIA airport mover (14458): out of scope
  '4831451, 5:00:00, 5:00:00,56,1,,0,0,,1',
  '4831451, 5:03:00, 5:03:00,10493,2,,0,0,2.0716,1',
  // bus 301 (31161), abridged to 3 of its 14 stops; the last is the real pickup_type=1 / drop_off_type=1 row
  '6322448,11:10:00,11:10:00,10369,1,,0,0,,1',
  '6322448,12:19:39,12:19:39,271,13,,0,0,63.3586,0',
  '6322448,12:20:00,12:20:00,9656,14,,1,1,63.5877,1',
];

const STOP_ROWS = [
  '56,MIA.TERT,MIAMI INTL AIRPORT GROUND LEVEL,MIA & LOWER LEVEL RAMP,25.795179,-80.27803,,,,,,2',
  '271,PALMW4AS,W PALM DR @ SW 4 AV,,25.44768,-80.48174,,,,,,2',
  '795,SCHLBRDI,SCHOOL BOARD METROMOVER STATION,,25.789376,-80.193145,,,,,,2',
  '796,OMNIMOVI,ADRIENNE ARSHT CENTER METROMOVER STATION,,25.789456,-80.187998,,,,,,2',
  '797,BCENPARI,MUSEUM PARK METROMOVER STATION,,25.785918,-80.187934,,,,,,2',
  '798,11STMOVI,ELEVENTH STREET METROMOVER STATION,NE 2 AV & NE 11 ST,25.784866,-80.19079,,,,,,2',
  '799,WORLDCEN,MIAMI WORLDCENTER STATION,,25.782476,-80.190643,,,,,,2',
  '800,FRDMTOWI,FREEDOM TOWER METROMOVER STATION,,25.780544,-80.190567,,,,,,2',
  '801,FINCDISI,FINANCIAL DISTRICT METROMOVER STATION,,25.760381,-80.192881,,,,,,2',
  '802,BRKLMOVI,BRICKELL METROMOVER STATION,,25.762664,-80.195261,,,,,,2',
  '803,10STMOVI,TENTH STREET PROMANADE METROMOVER STATION,,25.764016,-80.19256,,,,,,2',
  '804,8STRMOVI,BRICKELL CITY CENTRE METROMOVER STATION,,25.766888,-80.192121,,,,,,2',
  '805,5STRMOVI,FIFTH STREET METROMOVER STATION,,25.769165,-80.192248,,,,,,2',
  '806,RIVRWALI,RIVERWALK METROMOVER STATION,,25.771051,-80.192558,,,,,,2',
  '807,KNGTCNTI,KNIGHT CENTER METROMOVER STATION,,25.771865,-80.191377,,,,,,2',
  '808,BAY-FRNI,BAYFRONT PARK METROMOVER STATION,,25.773099,-80.187323,,,,,,2',
  '809,1STRMOVI,FIRST STREET METROMOVER STATION,,25.775726,-80.189849,,,,,,2',
  '810,BAY-SIDI,COLLEGE BAYSIDE METROMOVER STATION,,25.777584,-80.189915,,,,,,2',
  '811,COLLNORI,COLLEGE NORTH METROMOVER STATION,,25.778926,-80.192085,,,,,,2',
  '812,MIAARENI,WILKIE D FERGUSON METROMOVER STATION,NW 1 AV & NW 5 ST,25.778815,-80.195341,,,,,,2',
  '813,GOVTCNTT,GOVERNMENT CENTER METROMOVER STATION,,25.775864,-80.196093,,,,,,2',
  '832,BAY-FRNE,BISCAYNE BD@E FLAGLER ST,,25.773099,-80.187323,,,,,,2',
  '833,KNGTCNTE,KNIGHT CENTER METROMOVER STATION,,25.771865,-80.191377,,,,,,2',
  '834,MIA-AVEE,MIAMI AVENUE METROMOVER STATION,,25.773391,-80.193582,,,,,,2',
  '837,MIAARENW,WILKIE D FERGUSON METROMOVER STATION,,25.778815,-80.195341,,,,,,2',
  '838,COLLNORW,COLLEGE NORTH METROMOVER STATION,,25.778926,-80.192085,,,,,,2',
  '839,BAY-SIDW,COLLEGE BAYSIDE METROMOVER STATION,,25.777584,-80.189915,,,,,,2',
  '840,1STRMOVW,FIRST STREET METROMOVER STATION,NE 2 AV & NE 2 ST,25.775726,-80.189849,,,,,,2',
  '841,BAY-FRNW,BAYFRONT PARK METROMOVER STATION,,25.773099,-80.187323,,,,,,2',
  '9486,PALRAILS,PALMETTO STATION RAIL SOUTHBOUND,,25.843348,-80.323791,,,,,,2',
  '9487,PALRAILN,PALMETTO STATION RAIL NORTHBOUND,,25.843437,-80.323786,,,,,,2',
  '9488,OKERAILS,OKEECHOBEE STATION RAIL SOUTHBOUND,,25.839812,-80.301544,,,,,,2',
  '9489,OKERAILN,OKEECHOBEE STATION RAIL NORTHBOUND,,25.839899,-80.301547,,,,,,2',
  '9490,HIARAILS,HIALEAH STATION RAIL SOUTHBOUND,,25.841144,-80.278987,,,,,,2',
  '9491,HIARAILN,HIALEAH STATION RAIL NORTHBOUND,,25.841233,-80.278995,,,,,,2',
  '9492,TRIRAILS,TRI-RAIL STATION RAIL SOUTHBOUND,,25.845477,-80.259603,,,,,,2',
  '9493,TRIRAILN,TRI-RAIL STATION RAIL NORTHBOUND,,25.845523,-80.2596,,,,,,2',
  '9494,NSDRAILS,NORTHSIDE STATION RAIL SOUTHBOUND,,25.845815,-80.248828,,,,,,2',
  '9495,NSDRAILN,NORTHSIDE STATION RAIL NORTHBOUND,,25.845858,-80.248831,,,,,,2',
  '9496,MLKRAILS,M.L. KING STATION RAIL SOUTHBOUND,,25.832417,-80.241224,,,,,,2',
  '9497,MLKRAILN,M.L. KING STATION RAIL NORTHBOUND,,25.832422,-80.241132,,,,,,2',
  '9498,BVLRAILS,BROWNSVILLE STATION RAIL SOUTHBOUND,,25.822047,-80.240746,,,,,,2',
  '9499,BVLRAILN,BROWNSVILLE STATION RAIL NORTHBOUND,,25.822059,-80.240695,,,,,,2',
  '9500,EHTRAILS,EARLINGTON HTS.STAT.RAIL SOUTHBOUND,,25.812439,-80.229946,,,,,,2',
  '9501,EHTRAILN,EARLINGTON HTS.STAT.RAIL NORTHBOUND,,25.812525,-80.229946,,,,,,2',
  '9502,ALPRAILS,ALLAPATTAH STATION RAIL SOUTHBOUND,,25.808723,-80.215528,,,,,,2',
  '9503,ALPRAILN,ALLAPATTAH STATION RAIL NORTHBOUND,,25.808718,-80.215426,,,,,,2',
  '9504,SCLRAILS,SANTA CLARA STATION RAIL SOUTHBOUND,,25.795807,-80.215228,,,,,,2',
  '9505,SCLRAILN,SANTA CLARA STATION RAIL NORTHBOUND,,25.795809,-80.215174,,,,,,2',
  '9506,UHJRAILS,UHEALTH JACKSON STATION RAIL SOUTHBOUND,,25.789721,-80.215066,,,,,,2',
  '9507,UHJRAILN,UHEALTH JACKSON STATION RAIL NORTHBOUND,,25.789712,-80.215002,,,,,,2',
  '9508,CULRAILS,CULMER STATION RAIL SOUTHBOUND,,25.784525,-80.207551,,,,,,2',
  '9509,CULRAILN,CULMER STATION RAIL NORTHBOUND,,25.784614,-80.207599,,,,,,2',
  '9510,OVTRAILS,HISTORIC OVERTOWN/LYRIC THEATRE STAT.RAIL SOUTHBOUND,,25.781004,-80.196336,,,,,,2',
  '9511,OVTRAILN,HISTORIC OVERTOWN/LYRIC THEATRE STAT.RAIL NORTHBOUND,,25.781007,-80.196234,,,,,,2',
  '9512,GVTRAILS,GOVERNMENT CTR.STAT.RAIL SOUTHBOUND,,25.776047,-80.196157,,,,,,2',
  '9513,GVTRAILN,GOVERNMENT CTR.STAT.RAIL NORTHBOUND,,25.776044,-80.19603,,,,,,2',
  '9514,BKLRAILS,BRICKELL STATION RAIL SOUTHBOUND,,25.763833,-80.195532,,,,,,2',
  '9515,BKLRAILN,BRICKELL STATION RAIL NORTHBOUND,,25.763828,-80.19542,,,,,,2',
  '9516,VIZRAILS,VIZCAYA STATION RAIL SOUTHBOUND,,25.749771,-80.211802,,,,,,2',
  '9517,VIZRAILN,VIZCAYA STATION RAIL NORTHBOUND,,25.749684,-80.211752,,,,,,2',
  '9518,CGVRAILS,COCONUT GROVE STAT. RAIL SOUTHBOUND,,25.739875,-80.238912,,,,,,2',
  '9519,CGVRAILN,COCONUT GROVE STAT. RAIL NORTHBOUND,,25.739783,-80.238858,,,,,,2',
  '9520,DRDRAILS,DOUGLAS ROAD STAT. RAIL SOUTHBOUND,,25.732837,-80.254892,,,,,,2',
  '9521,DRDRAILN,DOUGLAS ROAD STAT. RAIL NORTHBOUND,,25.732764,-80.254812,,,,,,2',
  '9522,UNVRAILS,UNIVERSITY STATION RAIL SOUTHBOUND,,25.714825,-80.27712,,,,,,2',
  '9523,UNVRAILN,UNIVERSITY STATION RAIL NORTHBOUND,,25.714762,-80.277039,,,,,,2',
  '9524,SMIRAILS,SOUTH MIAMI STATION RAIL SOUTHBOUND,,25.705102,-80.289087,,,,,,2',
  '9525,SMIRAILN,SOUTH MIAMI STATION RAIL NORTHBOUND,,25.705013,-80.288999,,,,,,2',
  '9526,DLNRAILS,DADELAND NORTH STAT.RAIL SOUTHBOUND,,25.691933,-80.305207,,,,,,2',
  '9527,DLNRAILN,DADELAND NORTH STAT.RAIL NORTHBOUND,,25.691872,-80.305143,,,,,,2',
  '9528,DLSRAILS,DADELAND SOUTH STAT.RAIL SOUTHBOUND,,25.685075,-80.31374,,,,,,2',
  '9529,DLSRAILN,DADELAND SOUTH STAT.RAIL NORTHBOUND,,25.685003,-80.313656,,,,,,2',
  '9656,C344##26,SW 344 ST & SW 2 AV (E/F),,25.447694,-80.479102,,,,,,2',
  '10369,US#1M871,MILE MARKER 87 TAVRNIER,STATE HWY 5 & OVERSEAS HWY,24.959922,-80.568438,,,,,,2',
  '10493,MIA.STAT,AIRPORT STATION,Airport Station & (Lower level),25.798116,-80.258748,,,,,,2',
  '10494,MIARAILS,MIAMI INTERNATIONAL AIRPORT STATION SOUTHBOUND,,25.797965,-80.25859,,,,,,2',
  '10495,MIARAILN,MIAMI INTERNATIONAL AIRPORT STATION NORTHBOUND,,25.798002,-80.258746,,,,,,2',
];

/** Field `index` of a fixture row. The fixture's literal rows hold no quotes, so a split is exact. */
function fieldOf(row: string, index: number): string {
  invariant(!row.includes('"'), 'fixture rows are unquoted, so splitting on commas is exact');
  const value = row.split(',')[index];
  invariant(value !== undefined, `fixture row "${row}" has a field ${index}`);
  return value;
}

/** shapes.txt rows: each shape runs through the platforms of the first trip that uses it, in order. */
function shapeRows(): string[] {
  const coordinates = new Map(STOP_ROWS.map((row) => [fieldOf(row, 0), `${fieldOf(row, 4)},${fieldOf(row, 5)}`]));
  const shapeOfTrip = new Map(TRIP_ROWS.map((row) => [fieldOf(row, 2), fieldOf(row, 7)]));
  const tracedBy = new Map<string, string>();
  const lastSequence = new Map<string, number>();
  const rows: string[] = [];
  for (const row of STOP_TIME_ROWS) {
    const tripId = fieldOf(row, 0);
    const shapeId = shapeOfTrip.get(tripId);
    const point = coordinates.get(fieldOf(row, 3));
    invariant(shapeId !== undefined && point !== undefined, `stop_time "${row}" names a known trip and stop`);
    if ((tracedBy.get(shapeId) ?? tripId) === tripId) {
      tracedBy.set(shapeId, tripId);
      const sequence = (lastSequence.get(shapeId) ?? 0) + 1;
      lastSequence.set(shapeId, sequence);
      rows.push(`${shapeId},${point},${sequence},`);
    }
  }
  invariant(tracedBy.size === new Set(shapeOfTrip.values()).size, 'every trip shape gets points');
  return rows;
}

function csvText(header: string, rows: readonly string[]): string {
  invariant(rows.length > 0, 'every fixture file has data rows');
  const text = [header, ...rows].map((line) => line + CRLF).join('');
  invariant(!text.includes('\n\n') && text.endsWith(CRLF), 'fixture files are CRLF throughout, like the real feed');
  return text;
}

/** The text of each mini-feed file, exactly as the zip carries it. */
export const MINI_FEED: Readonly<Record<MiniFeedFile, string>> = {
  'agency.txt': csvText(HEADERS.agency, AGENCY_ROWS),
  'calendar.txt': csvText(HEADERS.calendar, CALENDAR_ROWS),
  'calendar_dates.txt': csvText(HEADERS.calendarDates, CALENDAR_DATE_ROWS),
  'routes.txt': csvText(HEADERS.routes, ROUTE_ROWS),
  'shapes.txt': csvText(HEADERS.shapes, shapeRows()),
  'stop_times.txt': csvText(HEADERS.stopTimes, STOP_TIME_ROWS),
  'stops.txt': BOM + csvText(HEADERS.stops, STOP_ROWS),
  'trips.txt': csvText(HEADERS.trips, TRIP_ROWS),
};

/** The zip entries (name → UTF-8 bytes), with overrides applied; `null` leaves a file out. */
export function miniFeedEntries(overrides: MiniFeedOverrides = {}): Record<string, Uint8Array> {
  invariant(Object.keys(overrides).every((name) => (MINI_FEED_FILES as readonly string[]).includes(name)), 'overrides name mini-feed files');
  const entries: Record<string, Uint8Array> = {};
  for (const name of MINI_FEED_FILES) {
    const text = overrides[name] === undefined ? MINI_FEED[name] : overrides[name];
    if (text !== null) {
      entries[name] = strToU8(text);
    }
  }
  invariant(Object.keys(entries).length <= MINI_FEED_FILES.length, 'entries are a subset of the mini-feed files');
  return entries;
}

/** The mini feed as zip bytes — byte-identical across runs (in one time zone) for the same overrides. */
export function miniFeedZip(overrides: MiniFeedOverrides = {}): Uint8Array {
  const entries = miniFeedEntries(overrides);
  invariant(Object.keys(entries).length > 0, 'a mini-feed zip holds at least one file');
  const zip = zipSync(entries, { level: 6, mtime: ZIP_MTIME });
  invariant(zip[0] === 0x50 && zip[1] === 0x4b, 'a zip starts with the PK signature');
  return zip;
}
