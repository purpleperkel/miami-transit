// Jamie's standards, mechanically enforced (plan §4 "Standards enforcement").
// `npm run lint` runs with `--max-warnings 0`, so a warning fails the gate exactly like an error.
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// src/domain is PURE: shared by the app and the Mac scripts, so it may not reach React, React
// Native, Expo or the app-only `@/` alias.
const DOMAIN_PURITY_MESSAGE =
  'src/domain is pure logic shared with the Mac scripts: no react, react-native, expo* or @/ imports.';
const DOMAIN_PURITY = {
  paths: [
    { name: 'react', message: DOMAIN_PURITY_MESSAGE },
    { name: 'react-native', message: DOMAIN_PURITY_MESSAGE },
    { name: 'expo', message: DOMAIN_PURITY_MESSAGE },
  ],
  patterns: [
    {
      group: ['react/*', 'react-native/*', 'react-native-*', '@react-native/*'],
      message: DOMAIN_PURITY_MESSAGE,
    },
    { group: ['expo/*', 'expo-*', '@expo/*'], message: DOMAIN_PURITY_MESSAGE },
    { group: ['@/*'], message: DOMAIN_PURITY_MESSAGE },
  ],
};

// The GTFS-realtime reference bindings (and the protobufjs under them) are a TEST ORACLE: app and
// domain code decode with src/domain/gtfsrt, so protobufjs never reaches the Hermes bundle.
// Only tests (`__tests__/`) and the Mac-side scripts may import them.
const ORACLE_ONLY_MESSAGE =
  'gtfs-realtime-bindings / protobufjs are a test oracle only — decode with src/domain/gtfsrt instead.';
const ORACLE_ONLY = {
  paths: [
    { name: 'gtfs-realtime-bindings', message: ORACLE_ONLY_MESSAGE },
    { name: 'protobufjs', message: ORACLE_ONLY_MESSAGE },
  ],
  patterns: [{ group: ['gtfs-realtime-bindings/*', 'protobufjs/*'], message: ORACLE_ONLY_MESSAGE }],
};

/** One `no-restricted-imports` setting from several restriction sets (flat config replaces, never merges, a rule). */
function restrictImports(...sets) {
  return [
    'error',
    { paths: sets.flatMap((set) => set.paths), patterns: sets.flatMap((set) => set.patterns) },
  ];
}

module.exports = defineConfig([
  // `.claude/` holds agent scaffolding, including git WORKTREES: whole second checkouts with their
  // own tsconfig.json. Two candidate roots make typescript-eslint's projectService refuse to pick
  // one, and the linter then crashes on scaffolding instead of reporting on source (documented in
  // roomsmith/eslint.config.js). `.cache/` and `.expo/` hold generated output; `dist/` is the export.
  globalIgnores(['dist/', '.cache/', '.expo/', '.claude/', 'node_modules/', 'evidence/']),
  expoConfig,
  {
    // Root tool configs (eslint, babel, metro) are CommonJS modules run by Node.
    files: ['*.config.js'],
    languageOptions: {
      globals: { __dirname: 'readonly', __filename: 'readonly' },
    },
  },
  {
    rules: {
      'max-lines-per-function': ['error', { max: 60 }],
      'no-empty': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting: the nearest tsconfig.json (root for the app, scripts/ for the Mac
        // tooling) supplies the program the promise and switch rules need.
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // node:test registers and awaits its own test()/describe() promises, so those calls are
      // the one known-safe float; every other unhandled promise is an error.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
          ],
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // A file gets exactly one no-restricted-imports setting — the LAST matching block's — so each
  // block lists every restriction that applies to its files.
  {
    files: ['src/**'],
    ignores: ['src/**/__tests__/**'],
    rules: { 'no-restricted-imports': restrictImports(ORACLE_ONLY) },
  },
  {
    files: ['src/domain/**'],
    ignores: ['src/domain/**/__tests__/**'],
    rules: { 'no-restricted-imports': restrictImports(DOMAIN_PURITY, ORACLE_ONLY) },
  },
  {
    files: ['src/domain/**/__tests__/**'],
    rules: { 'no-restricted-imports': restrictImports(DOMAIN_PURITY) },
  },
]);
