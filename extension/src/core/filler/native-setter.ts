/**
 * The native-setter path (ARCHITECTURE.md §3.3).
 *
 * `el.value = x` does not work on React. React caches the last value it set on
 * the node and compares against it; a direct assignment leaves that cache stale,
 * so React's `onChange` never fires and the field reverts on the next render or
 * submits empty. Calling the *prototype's* setter bypasses the value tracker,
 * and the dispatched events then look exactly like user input.
 *
 * This path is used unconditionally. It is correct on plain HTML, Vue and
 * Angular too — there is no reason to branch on the framework hint here.
 */

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function prototypeFor(el: ValueElement): object {
  if (el instanceof HTMLTextAreaElement) return HTMLTextAreaElement.prototype;
  if (el instanceof HTMLSelectElement) return HTMLSelectElement.prototype;
  return HTMLInputElement.prototype;
}

export function setNativeValue(el: ValueElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototypeFor(el), 'value');
  const setter = descriptor?.set;
  if (setter) setter.call(el, value);
  else el.value = value; // last resort; some engines expose no own descriptor
}

export function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  const setter = descriptor?.set;
  if (setter) setter.call(el, checked);
  else el.checked = checked;
}

export function dispatchInputEvents(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true })); // React onChange
  el.dispatchEvent(new Event('change', { bubbles: true })); // Vue / Angular / plain
}

/**
 * Write a value the way a person would: focus, set, notify, blur.
 *
 * The `blur` matters — a great many forms validate on blur and stay visibly red
 * (and sometimes block submission) if the field is never blurred.
 */
export function writeValue(el: ValueElement, value: string): void {
  el.focus();
  setNativeValue(el, value);
  dispatchInputEvents(el);
  el.blur();
}

/**
 * A synthetic keystroke burst, for controls that only react to key events —
 * character counters and some masked inputs.
 */
export function simulateKeystrokes(el: Element, value: string): void {
  const last = value.slice(-1) || ' ';
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    el.dispatchEvent(new KeyboardEvent(type, { key: last, bubbles: true, cancelable: true }));
  }
}
