#!/usr/bin/env bash
# m1c_device_probes — M1.14–M1.18: bundled probe DB, device modules, data/device probes, diagnostics route, NativeTabs + accessory.
# M1.19 (running the probes on Jamie's phone) is Jamie-owned and is NOT gated here.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
trap 'echo "ratchet: m1c_device_probes gate failed at verify script line $LINENO"' ERR

# A probe module must export each named probe as a function or const (word-bounded, so probeX does not match probeXY).
need_export() {
  local file="$1" name; shift
  for name in "$@"; do
    grep -qE "export (async )?function ${name}\b|export const ${name}\b" "$file" \
      || { echo "ratchet: $file does not export $name"; return 1; }
  done
}

# Something other than the probe module itself or a test (the route, or a src/ui/diagnostics component it renders) imports it.
need_importer() {
  local mod="$1" hits
  # grep -l exits 1 when nothing matches; the empty-result check below is the named failure.
  hits=$(grep -rlF --include='*.ts' --include='*.tsx' -- "$mod" src/app src/ui | grep -vF -e "/$mod.ts" -e "/__tests__/" || true)
  [ -n "$hits" ] || { echo "ratchet: nothing in src/app or src/ui imports $mod — the probes are not wired into the diagnostics route"; return 1; }
}

# The last `expo export` (.cache/export/metadata.json) bundled a db asset — the M1.14 V check, read right after a fresh export.
export_lists_db_asset() {
  node -e '
const m = require("./.cache/export/metadata.json");
const exts = m.fileMetadata.ios.assets.map((a) => a.ext);
if (!exts.includes("db")) { console.error("ratchet: export metadata lists no db asset (asset exts: " + [...new Set(exts)].join(",") + ")"); process.exit(1); }
console.log("export metadata lists a db asset");
' || return 1
}

# 1-2. SUPERSEDED 2026-10-02 (arbiter): M1.14's probe DB (scripts/probe/make-probe-db.ts -> assets/db/probe.db,
# 1000 rows) was RETIRED by M3.8 in 3c3debd ("probe DB retired"), when the real schedule DB provider replaced it.
# m3b's gate 9 now requires its ABSENCE, so these two gates could never pass again; this card's verify had been red
# since 3c3debd and was not re-run until mfix9's scan-scope sweep (mistake.reverified_by_file_not_by_scan_scope).
# The guarantee they gave (a node:sqlite DB opens in expo-sqlite, R4) is carried by the real schedule.db: m3b and
# M1.19 (R4 retired on Jamie's phone, 13:02 2026-10-01). Retirement itself is checked here so the supersession holds:
[ ! -e assets/db/probe.db ] && [ ! -e scripts/probe/make-probe-db.ts ] && need_file assets/db/schedule.db \
  || { echo "ratchet: M3.8 retired the probe DB; schedule.db must be the bundled DB"; exit 1; }
echo "ratchet: the M1.14 probe DB is retired (M3.8); schedule.db is the bundled DB"

# 3. M1.14: metro.config.js registers the db asset extension and a FRESH iOS export's metadata lists a db asset (the plan's V check).
need_file metro.config.js
need "assetExts" metro.config.js
ios_export
export_lists_db_asset

# 4. M1.15: all ten device modules are in package.json dependencies and installed, and `expo install --check` is clean (SDK-pinned).
node -e '
const fs = require("node:fs");
const deps = require("./package.json").dependencies || {};
const mods = ["expo-sqlite", "expo-location", "expo-notifications", "expo-haptics", "expo-linking",
  "expo-glass-effect", "expo-secure-store", "expo-crypto", "expo-file-system", "expo-symbols"];
const missing = mods.filter((m) => !deps[m]);
if (missing.length) { console.error("ratchet: not in package.json dependencies: " + missing.join(", ")); process.exit(1); }
const absent = mods.filter((m) => !fs.existsSync("node_modules/" + m + "/package.json"));
if (absent.length) { console.error("ratchet: listed but not installed: " + absent.join(", ")); process.exit(1); }
console.log("all " + mods.length + " device modules present");
'
npx expo install --check

# 5. M1.16: data-probes.ts exports the three data probes (SQLite asset count, protobuf fixture on Hermes, expo/fetch binary), returning Result.
need_file src/ui/diagnostics/data-probes.ts
need_export src/ui/diagnostics/data-probes.ts probeSqliteAsset probeProtobufDecode probeBinaryFetch
need "expo-sqlite" src/ui/diagnostics/data-probes.ts
need "vehicle-positions.fixture" src/ui/diagnostics/data-probes.ts
need "expo/fetch" src/ui/diagnostics/data-probes.ts
need "arrayBuffer" src/ui/diagnostics/data-probes.ts
need "byteLength" src/ui/diagnostics/data-probes.ts
need "lib/result" src/ui/diagnostics/data-probes.ts

# 6. M1.17: device-probes.ts exports the six device-API probes (notification, geocode, location, Liquid Glass, haptics, maps://), returning Result.
need_file src/ui/diagnostics/device-probes.ts
need_export src/ui/diagnostics/device-probes.ts probeNotification probeGeocode probeLocation probeLiquidGlass probeHaptics probeMapsLink
need "expo-notifications" src/ui/diagnostics/device-probes.ts
need "expo-location" src/ui/diagnostics/device-probes.ts
need "Government Center" src/ui/diagnostics/device-probes.ts
need "isLiquidGlassAvailable" src/ui/diagnostics/device-probes.ts
need "expo-haptics" src/ui/diagnostics/device-probes.ts
need "maps://" src/ui/diagnostics/device-probes.ts
need "lib/result" src/ui/diagnostics/device-probes.ts

# 7. M1.18: the diagnostics route exists and both probe modules are wired into the UI (not orphaned).
need_file src/app/diagnostics.tsx
need_importer data-probes
need_importer device-probes

# 8. M1.18: the map moved into the (tabs) group, whose layout is NativeTabs with a BottomAccessory; the old root index is gone.
need_file "src/app/(tabs)/_layout.tsx"
need_file "src/app/(tabs)/index.tsx"
[ ! -e src/app/index.tsx ] || { echo "ratchet: src/app/index.tsx still exists — M1.18 moves it to src/app/(tabs)/index.tsx"; exit 1; }
need "react-native-maps" "src/app/(tabs)/index.tsx"
need "NativeTabs" "src/app/(tabs)/_layout.tsx"
need "BottomAccessory" "src/app/(tabs)/_layout.tsx"

# 9. Repo-wide gate: tsc (app + scripts), eslint --max-warnings 0, standards checker, jest, node:test.
full_gate

# 10. Metro bundles the whole finished app for iOS (moved routes, new native modules) and the final bundle still carries the db asset.
ios_export
export_lists_db_asset

echo "m1c_device_probes: all 10 gates green"
