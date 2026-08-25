'use strict';
// Two module systems live in this repo and must not be linted as one: everything
// Node runs is CommonJS, while public/js is served to the browser as native ES
// modules with no bundler in between.
//
// eslint-plugin-n reads `engines` from package.json, so its
// no-unsupported-features rules enforce the Node floor this project actually
// promises rather than whatever version the contributor happens to run.
const { defineConfig, globalIgnores } = require('eslint/config');
const js = require('@eslint/js');
const n = require('eslint-plugin-n');
const globals = require('globals');

// `const { a, b, ...rest } = doc` is how this codebase drops fields it must not
// carry — the upload sha exclusion and the content strip both read that way — so
// a named sibling is the point, not an oversight. A bare `catch (e)` that
// deliberately swallows is the other shape worth allowing.
const NO_UNUSED_VARS = [
  'error',
  { caughtErrors: 'none', argsIgnorePattern: '^_', ignoreRestSiblings: true },
];

module.exports = defineConfig([
  globalIgnores(['node_modules/**', 'public/vendor/**', 'test/fixtures/**']),

  // The Node side: the watcher, the CLI, the hooks, the tests, and the two
  // standalone files that run inside a Claude Code session.
  {
    files: [
      'src/**/*.js',
      'hooks/**/*.js',
      'test/**/*.js',
      'scripts/**/*.js',
      'statusline-segment.js',
      'eslint.config.js',
    ],
    extends: [js.configs.recommended, n.configs['flat/recommended-script']],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // The CLI exits with a status on purpose, and hook-forward must always
      // exit 0 fast — exiting is the contract here, not an escape hatch.
      'n/no-process-exit': 'off',
      'no-unused-vars': NO_UNUSED_VARS,
    },
  },

  // `engines` is a promise to the people who install statusline, and the rule
  // above holds shipped code to it. Tests are never installed: they run on
  // whatever a contributor has, which is already 22.13 or newer because ESLint
  // 10 refuses to start below that. Holding them to the user floor would force
  // the product's minimum up for a reason no user is affected by.
  {
    files: ['test/**/*.js'],
    rules: {
      'n/no-unsupported-features/node-builtins': ['error', { version: '>=22.13.0' }],
    },
  },

  // The browser side: ES modules served straight from public/, no build step.
  {
    files: ['public/js/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': NO_UNUSED_VARS,
    },
  },
]);
