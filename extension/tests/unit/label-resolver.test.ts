import { beforeEach, describe, expect, it } from 'vitest';
import { resolveLabel, resolveSectionHeading } from '@/core/scanner/label-resolver';

/** Label resolution against DOM snippets — ARCHITECTURE.md §10, "Unit". */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const target = document.querySelector<HTMLElement>('[data-target]');
  if (!target) throw new Error('fixture is missing [data-target]');
  return target;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('resolveLabel priority ladder (§3.1)', () => {
  it('1. picks up an explicit <label for>', () => {
    const el = mount(`
      <label for="fn">First Name *</label>
      <input id="fn" data-target />
    `);
    expect(resolveLabel(el).blob).toContain('first name');
    expect(resolveLabel(el).displayLabel).toBe('First Name *');
  });

  it('2. picks up an ancestor <label>, ignoring the control inside it', () => {
    const el = mount(`
      <label>Postal code <input data-target value="ignored" /></label>
    `);
    expect(resolveLabel(el).blob).toContain('postal code');
  });

  it('3. resolves aria-labelledby across several ids', () => {
    const el = mount(`
      <span id="a">Desired</span><span id="b">salary</span>
      <input aria-labelledby="a b" data-target />
    `);
    expect(resolveLabel(el).blob).toContain('desired salary');
  });

  it('4. falls back to aria-label', () => {
    const el = mount(`<input aria-label="GitHub profile" data-target />`);
    expect(resolveLabel(el).blob).toContain('github profile');
  });

  it('5. finds the nearest preceding text in the container', () => {
    const el = mount(`
      <div><div><span>City</span><input data-target /></div></div>
    `);
    expect(resolveLabel(el).blob).toContain('city');
  });

  it('5. does not climb more than three levels for preceding text', () => {
    const el = mount(`
      <div><span>Too far away</span>
        <div><div><div><div><input data-target /></div></div></div></div>
      </div>
    `);
    expect(resolveLabel(el).blob).not.toContain('too far away');
  });

  it('6. uses the placeholder', () => {
    const el = mount(`<input placeholder="you@example.com" data-target />`);
    expect(resolveLabel(el).blob).toContain('you example com');
  });

  it('7. humanises name and id as a last resort', () => {
    const el = mount(`<input name="applicant[last_name]" id="lastName" data-target />`);
    const blob = resolveLabel(el).blob;
    expect(blob).toContain('applicant last name');
  });

  it('concatenates every signal, strongest first', () => {
    const el = mount(`
      <label for="e">Email *</label>
      <input id="e" name="email" placeholder="you@example.com" data-target />
    `);
    const { signals, blob } = resolveLabel(el);
    expect(signals[0]).toBe('Email *');
    expect(blob.startsWith('email')).toBe(true);
    expect(blob).toContain('you example com');
  });
});

describe('resolveSectionHeading', () => {
  it('prefers a fieldset legend', () => {
    const el = mount(`
      <fieldset><legend>Education</legend><input data-target /></fieldset>
    `);
    expect(resolveSectionHeading(el)).toBe('Education');
  });

  it('otherwise takes the nearest preceding heading', () => {
    const el = mount(`
      <h2>Employment history</h2>
      <div><input data-target /></div>
    `);
    expect(resolveSectionHeading(el)).toBe('Employment history');
  });

  it('returns undefined when there is no heading at all', () => {
    const el = mount(`<div><input data-target /></div>`);
    expect(resolveSectionHeading(el)).toBeUndefined();
  });
});
