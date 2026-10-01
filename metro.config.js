// Metro configuration (plan M1.14): bundled SQLite databases (`assets/db/*.db`) are ASSETS, shipped
// as files and opened on the phone by expo-sqlite — never parsed as source.
// Docs: https://docs.expo.dev/guides/customizing-metro.md ("Adding more file extensions to assetExts").
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo SDK 57's defaults already list `db`; this pins the requirement so a future default change
// cannot silently drop the schedule database from the bundle. Added once, never duplicated.
const DB_ASSET_EXT = 'db';
if (!config.resolver.assetExts.includes(DB_ASSET_EXT)) {
  config.resolver.assetExts.push(DB_ASSET_EXT);
}
if (!config.resolver.assetExts.includes(DB_ASSET_EXT) || config.resolver.sourceExts.includes(DB_ASSET_EXT)) {
  throw new Error('metro.config.js: .db files must resolve as assets, not source');
}

module.exports = config;
