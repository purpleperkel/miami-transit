# Miami Transit

Personal iPhone app: live Metrorail + Metromover on a clean Apple map, next arrivals, saved
trips with a "leave in N min" countdown. Runs inside the App Store **Expo Go** (SDK 57).

## Open it on the iPhone (no Mac needed)
Published updates load in Expo Go (signed in as `jamieperkel`) from:

    exp://u.expo.dev/f1d15d42-826a-4d23-afaa-d6e0fa1e6d1a?runtime-version=1.0.0&channel-name=production

Home Screen icon: Shortcuts app → New Shortcut → "Open URLs" with the link above →
Share → Add to Home Screen (name it "Miami Transit").

## Develop
    npx expo start --lan        # then open "miami-transit" under Development servers in Expo Go
    npm run verify              # the gate (from M1 on)

Plan: `/Users/jacobperkel/.claude/plans/could-i-make-an-fluttering-charm.md`. Working rules: `CLAUDE.md`.

## Data
Schedules: Miami-Dade DTPW GTFS (public). Realtime: Miami-Dade DTPW via Swiftly, and via
[Transitland](https://www.transit.land/terms). API keys live only in the iOS Keychain (on device)
and the gitignored `.env` (Mac probe scripts) — never in this repo.
