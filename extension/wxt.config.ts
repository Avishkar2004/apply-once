import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { ATS_MATCH_PATTERNS } from './src/shared/hosts';

// ARCHITECTURE.md §7 — WXT (Manifest V3), TypeScript strict, React 19 + Tailwind.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // WXT hard-wires `@` to `srcDir`, so `srcDir` is `src/` — that is what every
  // `@/…` import in this package means. The entrypoints stay a sibling of `src/`
  // to match the repository layout in ARCHITECTURE.md §8.
  srcDir: 'src',
  entrypointsDir: '../entrypoints',
  outDir: '.output',

  // Resolve the workspace core package to its TypeScript sources so the
  // extension and Vitest compile exactly the same files.
  alias: {
    '@autofill/core': '../packages/core/src/index.ts',
  },

  manifest: ({ browser }) => ({
    name: 'AutoFill',
    description: 'Fill job application forms from a profile you maintain once. Never auto-submits.',
    // Least privilege (§6.5): no <all_urls>, no tabs, no webRequest.
    // `activeTab` + `scripting` is what makes this work on ANY site without
    // asking for `<all_urls>`. Clicking the toolbar icon grants this extension
    // temporary access to that one tab, and only then do we inject. No passive
    // access to any page, ever — strictly less reach than a blanket host
    // permission, while working everywhere the user actually asks it to.
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'alarms',
      ...(browser === 'firefox' ? [] : ['sidePanel']),
    ],
    host_permissions: [...ATS_MATCH_PATTERNS],
    // Requested from the options page only when the user supplies their own
    // Anthropic key (§6.4) — never granted at install.
    optional_host_permissions: ['https://api.anthropic.com/*'],
    action: { default_title: 'AutoFill — review and fill this application' },
    ...(browser === 'firefox' ? {} : { side_panel: { default_path: 'sidepanel.html' } }),
    // No remote code, ever. `wasm-unsafe-eval` is required by onnxruntime-web,
    // which runs the Tier 2 embedding model from extension-local assets (§3.2).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  }),

  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
