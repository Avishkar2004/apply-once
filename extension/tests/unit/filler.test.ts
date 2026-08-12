import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedValue } from '@autofill/core';
import { AutoSubmitBlockedError, isSubmitControl, safeClick } from '@/core/filler/guards';
import { setNativeValue, writeValue } from '@/core/filler/native-setter';
import { matchOption } from '@/core/filler/option-matcher';
import { fillCheckbox, fillSelect, fillTextLike } from '@/core/filler/strategies';
import { fillDelay, FILL_DELAY_MAX_MS, FILL_DELAY_MIN_MS } from '@/core/filler/pacing';

const value = (text: string, candidates: string[] = [], extra: Partial<ResolvedValue> = {}): ResolvedValue => ({
  key: 'personal.firstName',
  type: 'text',
  text,
  candidates: [text, ...candidates],
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('native setter (§3.3)', () => {
  it('writes through the prototype setter, bypassing a framework value tracker', () => {
    document.body.innerHTML = `<input id="x" />`;
    const input = document.getElementById('x') as HTMLInputElement;

    // Simulate React's value tracker: an own `value` property shadowing the
    // prototype accessor. A naive `el.value = x` would write only to this.
    let shadowed = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => shadowed,
      set: (next: string) => {
        shadowed = next;
      },
    });

    setNativeValue(input, 'Ada');

    // The prototype setter reached the real value, not the shadow.
    expect(shadowed).toBe('');
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input)).toBe('Ada');
  });

  it('dispatches input and change, and blurs so on-blur validation runs', () => {
    document.body.innerHTML = `<input id="x" />`;
    const input = document.getElementById('x') as HTMLInputElement;

    const seen: string[] = [];
    for (const type of ['focus', 'input', 'change', 'blur']) {
      input.addEventListener(type, () => seen.push(type));
    }

    writeValue(input, 'hello');
    expect(seen).toEqual(['focus', 'input', 'change', 'blur']);
    expect(input.value).toBe('hello');
  });
});

describe('no auto-submit (§6.7)', () => {
  it.each([
    '<button type="submit">Go</button>',
    '<input type="submit" value="Apply" />',
    '<form><button>Submit</button></form>',
    '<a role="button">Submit application</a>',
    '<button type="button">Apply now</button>',
  ])('recognises %s as a submit control', (html) => {
    document.body.innerHTML = html;
    const el = document.querySelector('button, input, a')!;
    expect(isSubmitControl(el)).toBe(true);
  });

  it('does not mistake a checkbox labelled "apply" for a submit control', () => {
    document.body.innerHTML = `<input type="checkbox" aria-label="Apply to all locations" />`;
    const el = document.querySelector('input')!;
    expect(isSubmitControl(el)).toBe(false);
  });

  it('refuses to click a submit control', () => {
    document.body.innerHTML = `<button type="submit">Submit</button>`;
    const button = document.querySelector('button')!;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    expect(() => safeClick(button)).toThrow(AutoSubmitBlockedError);
    expect(clicked).not.toHaveBeenCalled();
  });

  it('clicks ordinary controls', () => {
    document.body.innerHTML = `<button type="button">Add another</button>`;
    const button = document.querySelector('button')!;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    safeClick(button);
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('option matching (§3.3)', () => {
  const options = [
    { value: '', text: 'Select…' },
    { value: 'US', text: 'United States' },
    { value: 'GB', text: 'United Kingdom' },
    { value: 'DE', text: 'Germany' },
  ];

  it('never picks the placeholder row', () => {
    expect(matchOption(options, ['nothing like these'])).toBeNull();
  });

  it('matches on exact value first', () => {
    expect(matchOption(options, ['US'])).toMatchObject({ how: 'value', index: 1 });
  });

  it('matches on exact text', () => {
    expect(matchOption(options, ['United Kingdom'])).toMatchObject({ how: 'text', index: 2 });
  });

  it('matches on normalised text', () => {
    expect(matchOption(options, ['united  states!'])).toMatchObject({ how: 'normalized', index: 1 });
  });

  it('falls back to fuzzy within the documented Levenshtein ceiling', () => {
    expect(matchOption(options, ['Germny'])).toMatchObject({ index: 3 });
    expect(matchOption(options, ['Grmy'])).toBeNull();
  });

  it('tries candidates in order, best first', () => {
    const yesNo = [
      { value: '1', text: 'Yes' },
      { value: '0', text: 'No' },
    ];
    expect(matchOption(yesNo, ['Yes', 'true', '1'])).toMatchObject({ index: 0, how: 'text' });
  });
});

describe('per-kind strategies', () => {
  it('fills a text input', () => {
    document.body.innerHTML = `<input id="x" />`;
    const el = document.getElementById('x')!;
    expect(fillTextLike(el, value('Ada'))).toEqual({ ok: true, wrote: 'Ada' });
    expect((el as HTMLInputElement).value).toBe('Ada');
  });

  it('selects a matching option and fires change', () => {
    document.body.innerHTML = `
      <select id="s"><option value="">Select</option><option value="US">United States</option></select>
    `;
    const el = document.getElementById('s') as HTMLSelectElement;
    const changed = vi.fn();
    el.addEventListener('change', changed);

    expect(fillSelect(el, value('United States', ['US']))).toEqual({ ok: true, wrote: 'United States' });
    expect(el.value).toBe('US');
    expect(changed).toHaveBeenCalled();
  });

  it('reports a select with no matching option instead of leaving it wrong', () => {
    document.body.innerHTML = `<select id="s"><option value="A">Alpha</option></select>`;
    const el = document.getElementById('s')!;
    expect(fillSelect(el, value('Omega'))).toEqual({ ok: false, reason: 'no matching option' });
  });

  it('clicks a checkbox rather than assigning `checked`', () => {
    document.body.innerHTML = `<input type="checkbox" id="c" />`;
    const el = document.getElementById('c') as HTMLInputElement;
    const clicked = vi.fn();
    el.addEventListener('click', clicked);

    fillCheckbox(el, value('Yes', [], { boolean: true }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(el.checked).toBe(true);
  });

  it('leaves an already-correct checkbox alone', () => {
    document.body.innerHTML = `<input type="checkbox" id="c" checked />`;
    const el = document.getElementById('c') as HTMLInputElement;
    const clicked = vi.fn();
    el.addEventListener('click', clicked);

    fillCheckbox(el, value('Yes', [], { boolean: true }));
    expect(clicked).not.toHaveBeenCalled();
    expect(el.checked).toBe(true);
  });
});

describe('pacing (§3.3)', () => {
  it('stays inside the documented 30–80ms jitter window', () => {
    expect(fillDelay(() => 0)).toBe(FILL_DELAY_MIN_MS);
    expect(fillDelay(() => 0.999)).toBeLessThanOrEqual(FILL_DELAY_MAX_MS);
  });
});
