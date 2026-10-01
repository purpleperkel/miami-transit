import { probeBinaryFetch, probeProtobufDecode, probeSqliteAsset } from './data-probes';
import {
  probeGeocode,
  probeHaptics,
  probeLiquidGlass,
  probeLocation,
  probeMapsLink,
  probeNotification,
} from './device-probes';
import type { ProbeOutcome } from './probe-kit';

/** One row on the Diagnostics screen: what the probe checks, and how to run it. */
export type ProbeSpec = {
  readonly id: string;
  readonly title: string;
  /** What a PASS means, in the words of the plan (M1.16–M1.17). */
  readonly expectation: string;
  readonly run: () => Promise<ProbeOutcome>;
  /** True when running it leaves the app (so "Run all" skips it; it runs on its own tap). */
  readonly leavesApp: boolean;
};

/** Every M1 probe, in the order the Diagnostics screen lists (and "Run all" runs) them. */
export const PROBES: readonly ProbeSpec[] = [
  {
    id: 'sqlite',
    title: 'SQLite asset',
    expectation: 'The bundled schedule DB opens in expo-sqlite; its feed, schema and counts match the manifest',
    run: probeSqliteAsset,
    leavesApp: false,
  },
  {
    id: 'protobuf',
    title: 'Protobuf on Hermes',
    expectation: 'Our GTFS-realtime decoder reproduces the fixture field for field',
    run: probeProtobufDecode,
    leavesApp: false,
  },
  {
    id: 'fetch',
    title: 'Binary fetch',
    expectation: 'expo/fetch returns the county zip head as intact bytes',
    run: probeBinaryFetch,
    leavesApp: false,
  },
  {
    id: 'notification',
    title: 'Local notification',
    expectation: 'Arrives 5 s later, also with the app in the background',
    run: probeNotification,
    leavesApp: false,
  },
  {
    id: 'geocode',
    title: 'Geocode',
    expectation: 'Government Center lands within 1 km of the station',
    run: probeGeocode,
    leavesApp: false,
  },
  { id: 'location', title: 'Location', expectation: 'A foreground location fix', run: probeLocation, leavesApp: false },
  {
    id: 'glass',
    title: 'Liquid Glass',
    expectation: 'Liquid Glass is available',
    run: probeLiquidGlass,
    leavesApp: false,
  },
  { id: 'haptics', title: 'Haptics', expectation: 'A success haptic you can feel', run: probeHaptics, leavesApp: false },
  {
    id: 'maps',
    title: 'maps:// link',
    expectation: 'Apple Maps opens at Government Center (leaves the app)',
    run: probeMapsLink,
    leavesApp: true,
  },
];
