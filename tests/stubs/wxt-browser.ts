/**
 * An in-memory stand-in for `wxt/browser` under Vitest.
 *
 * WXT resolves that import through its Vite plugin, which the unit suite does
 * not run. Aliasing it here is what lets storage-touching modules — the answer
 * bank, the audit log, settings — be tested as ordinary code instead of being
 * quarantined behind the extension boundary.
 *
 * Only the surface AutoFill actually uses is implemented. Anything else should
 * fail loudly rather than silently return undefined.
 */

type Listener = (...args: unknown[]) => void;

function createArea() {
  const store = new Map<string, unknown>();
  return {
    async get(keys?: string | string[]) {
      if (keys === undefined) return Object.fromEntries(store);
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)]),
      );
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    async clear() {
      store.clear();
    },
    /** Test helper — not part of the real API. */
    __store: store,
  };
}

const grantedOrigins = new Set<string>();

export const browser = {
  runtime: {
    id: 'autofill-test',
    getURL: (path: string) => `chrome-extension://autofill-test/${path.replace(/^\//, '')}`,
    sendMessage: async () => undefined,
    onMessage: {
      addListener: (_listener: Listener) => undefined,
      removeListener: (_listener: Listener) => undefined,
    },
    openOptionsPage: async () => undefined,
  },
  storage: {
    local: createArea(),
    sync: createArea(),
    session: createArea(),
  },
  permissions: {
    contains: async ({ origins = [] }: { origins?: string[] }) =>
      origins.every((origin) => grantedOrigins.has(origin)),
    request: async ({ origins = [] }: { origins?: string[] }) => {
      origins.forEach((origin) => grantedOrigins.add(origin));
      return true;
    },
    remove: async ({ origins = [] }: { origins?: string[] }) => {
      origins.forEach((origin) => grantedOrigins.delete(origin));
      return true;
    },
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => undefined,
  },
  action: { onClicked: { addListener: (_listener: Listener) => undefined } },
  alarms: { create: () => undefined, onAlarm: { addListener: (_l: Listener) => undefined } },
};

/** Reset every in-memory area between tests. */
export function __resetBrowserStub(): void {
  browser.storage.local.__store.clear();
  browser.storage.sync.__store.clear();
  browser.storage.session.__store.clear();
  grantedOrigins.clear();
}
