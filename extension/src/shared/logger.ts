/**
 * Namespaced logging.
 *
 * Never log a profile value. The scanner and mapper deal in labels; the filler
 * deals in values, and it logs only lengths and outcomes. This is enforced by
 * convention plus the `redact` helper below — use it whenever a value is
 * genuinely needed for a diagnosis.
 */

const PREFIX = '[AutoFill]';

const enabled = (): boolean => {
  try {
    return import.meta.env.MODE !== 'production';
  } catch {
    return false;
  }
};

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const tag = `${PREFIX} ${scope}`;
  return {
    debug: (...args) => enabled() && console.debug(tag, ...args),
    info: (...args) => enabled() && console.info(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
  };
}

/** `"jane@example.com"` → `"‹14 chars›"`. Safe to log. */
export function redact(value: string | undefined | null): string {
  if (value === undefined || value === null) return '‹none›';
  return `‹${value.length} chars›`;
}
