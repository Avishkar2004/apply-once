import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Two of these rule blocks are load-bearing architecture, not style.
 *
 * WEB.md §9:  "`packages/core` must not import `chrome.*` or touch the DOM — it
 *              runs in a service worker, a browser tab, and Vitest. Enforce with
 *              a lint rule, not with discipline."
 * WEB.md §12: "Lint rule banning `localStorage` in `web/` and `core/`, enforced
 *              in CI" — one careless commit otherwise puts a key in plaintext.
 */

const NO_PLAINTEXT_STORAGE = [
  {
    name: 'localStorage',
    message:
      'Never localStorage (WEB.md §3.2). Keys and profile data go through storage/session.ts or the encrypted Dexie stores.',
  },
  {
    name: 'sessionStorage',
    message: 'Never sessionStorage. Use chrome.storage.session via storage/session.ts.',
  },
];

const CORE_MUST_STAY_PORTABLE = [
  ...NO_PLAINTEXT_STORAGE,
  { name: 'chrome', message: 'packages/core must not touch extension APIs (WEB.md §9).' },
  { name: 'browser', message: 'packages/core must not touch extension APIs (WEB.md §9).' },
  { name: 'document', message: 'packages/core must not touch the DOM (WEB.md §9).' },
  { name: 'window', message: 'packages/core must not touch the DOM (WEB.md §9).' },
  { name: 'navigator', message: 'packages/core must not touch the DOM (WEB.md §9).' },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // TypeScript already resolves identifiers; `no-undef` only produces
      // false positives on DOM and worker globals here.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    // WEB.md §12 — applies to every client surface.
    files: ['packages/**/*.{ts,tsx}', 'extension/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': ['error', ...NO_PLAINTEXT_STORAGE] },
  },

  {
    // WEB.md §9 — the shared package stays portable.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...CORE_MUST_STAY_PORTABLE],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['wxt', 'wxt/*'], message: 'packages/core must not depend on the extension framework (WEB.md §9).' },
            { group: ['dexie'], message: 'packages/core must not depend on a storage backend (WEB.md §9).' },
            { group: ['@/*'], message: 'packages/core must not import from the extension (WEB.md §9).' },
            { group: ['react', 'react-dom'], message: 'packages/core must not depend on a UI library (WEB.md §9).' },
          ],
        },
      ],
    },
  },

  {
    // The no-auto-submit invariant (ARCHITECTURE.md §6.7) is architectural.
    // `safeClick` is the only sanctioned click path in the filler.
    files: ['extension/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='requestSubmit']",
          message: 'AutoFill never submits an application (ARCHITECTURE.md §6.7).',
        },
        {
          selector: "CallExpression[callee.property.name='submit'][callee.object.name=/form/i]",
          message: 'AutoFill never submits an application (ARCHITECTURE.md §6.7).',
        },
      ],
    },
  },
);
