/**
 * Bundled SQLite databases (`assets/db/*.db`) resolve as Metro ASSETS (metro.config.js). Importing
 * one yields the numeric asset id that expo-sqlite's `assetSource.assetId` (and expo-asset) expect.
 */
declare module '*.db' {
  const assetId: number;
  export default assetId;
}
