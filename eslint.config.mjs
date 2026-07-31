import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Generated output: framework types, the OpenNext bundle, and the
    // Wrangler-generated binding types. None of it is ours to fix.
    ignores: [
      '.next/**',
      'dist/**',
      '.open-next/**',
      '.wrangler/**',
      'node_modules/**',
      'coverage/**',
      'next-env.d.ts',
      'cloudflare-env.d.ts',
    ],
  },
  {
    // Electron's main process is CommonJS — it is loaded by Electron's own
    // Node runtime, not by the bundler, so ESM-only rules do not apply.
    files: ['desktop/**/*.js'],
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
