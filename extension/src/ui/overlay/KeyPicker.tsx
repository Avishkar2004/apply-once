import { useMemo } from 'react';
import { CANONICAL_KEYS, CANONICAL_KEY_META, type CanonicalKey } from '@autofill/core';

/**
 * "Pick a field" — the control that turns a ⬜ skipped row into a learned
 * override (ARCHITECTURE.md §3.5).
 *
 * It offers the canonical vocabulary and nothing else, which is what keeps a
 * correction reusable: the user is choosing a *profile field*, not typing a
 * value for this one form.
 */
export function KeyPicker({
  value,
  onChange,
  disabled,
}: {
  value?: CanonicalKey | undefined;
  onChange: (key: CanonicalKey) => void;
  disabled?: boolean;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, CanonicalKey[]>();
    for (const key of CANONICAL_KEYS) {
      const group = CANONICAL_KEY_META[key].group;
      const bucket = groups.get(group);
      if (bucket) bucket.push(key);
      else groups.set(group, [key]);
    }
    return [...groups.entries()];
  }, []);

  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        const next = event.target.value;
        if (next) onChange(next as CanonicalKey);
      }}
    >
      <option value="">Pick a field…</option>
      {grouped.map(([group, keys]) => (
        <optgroup key={group} label={group}>
          {keys.map((key) => (
            <option key={key} value={key}>
              {CANONICAL_KEY_META[key].label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
