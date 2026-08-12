import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// happy-dom ships a `crypto` stub without a full SubtleCrypto. The crypto module
// (packages/core/src/crypto) is WebCrypto-only by design, so hand it the real one.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
