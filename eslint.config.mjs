import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Generated output: the framework build, the assembled desktop server
    // bundle and the packaged installers. None of it is ours to fix.
    ignores: [
      '.next/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'next-env.d.ts',
    ],
  },
  {
    // CommonJS by necessity, not by preference: Electron's main process is
    // loaded by Electron's own Node runtime and electron-builder requires its
    // hooks the same way. Neither goes through the bundler, so the ESM-only
    // rules do not apply.
    files: ['desktop/**/*.js', 'scripts/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      // The codebase uses `_`-prefixed parameters for deliberately unused
      // handler arguments (route params, event objects).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
