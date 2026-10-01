// Jamie's standards, mechanically enforced (plan §4 "Standards enforcement").
// `npm run lint` runs with `--max-warnings 0`, so a warning fails the gate exactly like an error.
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// src/domain is PURE: shared by the app and the Mac scripts, so it may not reach React, React
// Native, Expo or the app-only `@/` alias.
const DOMAIN_PURITY_MESSAGE =
  'src/domain is pure logic shared with the Mac scripts: no react, react-native, expo* or @/ imports.';

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
  {
    files: ['src/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
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
        },
      ],
    },
  },
]);
