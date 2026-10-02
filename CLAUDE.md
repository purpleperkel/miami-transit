# Miami Transit — working rules for this repo

Personal iPhone app: live Metrorail + Metromover map, next arrivals, saved trips with a
"leave in N min" countdown. Runs inside the App Store **Expo Go** (SDK 57) — there is NO
Xcode and NO iOS simulator on this Mac. Plan of record:
`/Users/jacobperkel/.claude/plans/could-i-make-an-fluttering-charm.md` (read the section for
your milestone before writing code). Also read `AGENTS.md` (Expo: fetch versioned docs for
SDK 57; never trust memory for Expo APIs).

## Layout (do not invent new top-level homes)
- `src/app/` routes only (expo-router). `src/lib/` invariant/result/geo.
- `src/domain/` PURE logic — must not import react, react-native, expo*, or `@/` aliases
  (lint-enforced). Shared by the app AND the Mac scripts via relative imports.
- `src/data/` SQL executors + repos. `src/live/` realtime runtime. `src/ui/` components.
- `scripts/` Mac-side tooling (GTFS pipeline, probes, standards checker), run with tsx.
- `assets/db/` generated schedule DB + manifest (committed). `.cache/`, `evidence/`, `.env*`
  are gitignored.

## Coding standards (Jamie's — mechanically enforced by `npm run verify` once M1 lands)
- Functions ≤ 60 lines. ≥ 2 `invariant()` assertions per named function (pre/postconditions).
  As enforced by `scripts/check/standards.ts`: "named" = function declarations, methods, named
  function expressions, and functions assigned to a variable / class property / `export default`.
  Anonymous callbacks ≤ 5 lines are exempt; longer ones need 2 assertions (in test files
  `expect(...)`, `assert(...)`, `assert.x(...)` count). `describe`/`suite` callbacks are containers —
  each test inside is checked on its own. `invariant` itself is the one exemption.
  NOTE: the 60-line limit (eslint + standards) DOES apply to `describe` callbacks — split a long suite into
  several describe blocks (found by the mfix builder, 2026-10-01).
- No recursion (bounded loops only). No silent catch — return `err(...)` or rethrow.
- Check every return value / promise (no floating promises). Zero warnings
  (`eslint --max-warnings 0`, `tsc` strict).
- No stubs, no TODO/FIXME markers, no skipped tests. Test-time mocks of NATIVE modules
  (react-native-maps, expo-glass-effect, expo-haptics…) are allowed in jest only and must be
  labelled `// test-time mock of native module` at the `jest.mock` call.
- Install Expo packages with `npx expo install <pkg>` (SDK-pinned; for dev deps use `npx expo install <pkg> --dev`,
  NOT `-- --save-dev`, which lands them in dependencies), other dev tools with `npm i -D --save-exact`.
- TS trap (found by the m10a builder, 2026-10-02): `invariant(Array.isArray(x))` on a `readonly T[]` parameter narrows `x` to
  `readonly T[] & any[]`, and every callback on `x` then gets implicit-any parameters (TS7006). Use a meaningful precondition
  instead (e.g. on length or element shape), not extra type annotations.
- Jest timer trap (found by the mfix5 builder, 2026-10-02): `act()` renders only when its scope ends, so one long
  `advanceTimersByTimeAsync` collapses every 15 s tick into a single render. Sheet/clock tests must step the fake clock
  in small increments (e.g. 1 s) inside act.
- Gate trap (found by the mfix9 reviewer, 2026-10-02): the verify scripts' `mocks_native_only` reads EVERY source file under a
  scanned `__tests__` directory, helper files included, and takes a `jest.mock(` written inside a doc comment for a real call
  (then demands a package target and the label). In a helper's comments, describe such a mock in prose ("each test file mocks
  'expo-location' with …"), never as a `jest.mock(…)` example.
- Location (mfix6, 2026-10-02): ONE app-wide `UserLocationProvider` (src/ui/location/) owns the only `watchPositionAsync`;
  any test rendering something that reads the rider's position (`useUserPosition`) must wrap it in `<UserLocationProvider>`
  or it throws by design. Never open a second watch.
- Network (mfix10, 2026-10-02): the live runtime owns the app's ONE expo-network watch (src/live/network-watch.ts),
  which LiveDataProvider hands it. Any test that renders the real `LiveDataProvider` needs a labelled
  `// test-time mock of native module` expo-network mock whose `addNetworkStateListener` returns a subscription with
  `remove()`: jest-expo's automock returns a Promise instead, and the watch refuses it with an invariant. On every
  resume (the mount while active included) the runtime asks `getNetworkStateAsync` and HOLDS its poller: no tick, no
  provider switch, the published gate as it was, until a heartbeat finds the answer in (or `RESUME_READING_TIMEOUT_MS`,
  3 s, passes: no reading, so off Wi-Fi). A test that calls `runtime.resume()` by hand must tick once after the answer
  lands before anything polls. Swiftly never starts a request to an endpoint within 30 s of its last start there
  (providers/swiftly.ts), whatever the scheduler asks. KNOWN UPSTREAM LIMIT (expo-network 57.0.2,
  ios/NetworkModule.swift): its one NWPathMonitor is cancelled when the last listener goes and cannot restart, so after
  a runtime stop and start in one app session listener events stop until relaunch; resume asks still run.
- `babel.config.js` exists because jest-expo 57.0.5's `jest-expo/ios` preset needs Expo's babel preset
  to parse React Native's jest setup. TypeScript 6 defaults `types` to `[]` — the tsconfigs set it explicitly.

## Secrets
Realtime API keys NEVER appear in source, tests, fixtures, commits or chat. On the phone they
live in the iOS Keychain (expo-secure-store); on the Mac only in the gitignored `.env`, read by
`scripts/live/probe-*.ts`. Do not use `EXPO_PUBLIC_*` for keys.

## Verification
- Tests: jest (`jest-expo/ios`) for `src/**/__tests__`; `node --import tsx --test` for
  `scripts/**/__tests__` (these need `node:sqlite`).
- The gate for any task: `npm run verify` (+ `npx expo export --platform ios --output-dir
  .cache/export` when UI/routes change). Paste real output; "should pass" is not evidence.

## Commits
Descriptive message naming the milestone; end with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
