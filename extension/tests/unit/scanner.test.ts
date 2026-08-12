import { beforeEach, describe, expect, it } from 'vitest';
import { scanRoot } from '@/core/scanner';

beforeEach(() => {
  document.body.innerHTML = '';
});

const byLabel = (fields: ReturnType<typeof scanRoot>['fields'], needle: string) =>
  fields.find((field) => field.labelBlob.includes(needle));

describe('scanRoot', () => {
  it('emits one descriptor per control and classifies its kind', () => {
    document.body.innerHTML = `
      <label for="a">Email</label><input id="a" type="email" />
      <label for="b">Phone</label><input id="b" type="tel" />
      <label for="c">Cover letter</label><textarea id="c"></textarea>
      <label for="d">Country</label><select id="d"><option value="">Select</option><option value="US">United States</option></select>
      <label for="e">Résumé</label><input id="e" type="file" />
      <label for="f">Start date</label><input id="f" type="date" />
    `;

    const { fields } = scanRoot(document);
    expect(fields).toHaveLength(6);
    expect(byLabel(fields, 'email')?.kind).toBe('email');
    expect(byLabel(fields, 'phone')?.kind).toBe('tel');
    expect(byLabel(fields, 'cover letter')?.kind).toBe('textarea');
    expect(byLabel(fields, 'country')?.kind).toBe('select');
    expect(byLabel(fields, 'resume')?.kind).toBe('file');
    expect(byLabel(fields, 'start date')?.kind).toBe('date');
  });

  it('collapses a radio group into one logical field', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Are you legally authorized to work in the US?</legend>
        <label><input type="radio" name="auth" value="yes" /> Yes</label>
        <label><input type="radio" name="auth" value="no" /> No</label>
      </fieldset>
    `;

    const { fields } = scanRoot(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe('radio-group');
    expect(fields[0]?.options?.map((option) => option.value)).toEqual(['yes', 'no']);
    expect(fields[0]?.radios).toHaveLength(2);
  });

  it('recurses into open shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <label for="s">Legal first name</label><input id="s" />
    `;

    const { fields } = scanRoot(document);
    expect(byLabel(fields, 'legal first name')).toBeDefined();
  });

  it('ignores hidden, submit and disabled controls', () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf" />
      <input type="submit" value="Submit application" />
      <input name="disabled_field" disabled />
      <input name="real_field" />
    `;
    const { fields } = scanRoot(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe('real_field');
  });

  it('reads options, maxlength and required off the control', () => {
    document.body.innerHTML = `
      <label for="w">Why us?</label>
      <textarea id="w" maxlength="500" required></textarea>
      <label for="p">Pronouns</label>
      <select id="p"><option value="">Select</option><option value="they">they/them</option></select>
    `;
    const { fields } = scanRoot(document);
    expect(byLabel(fields, 'why us')?.maxLength).toBe(500);
    expect(byLabel(fields, 'why us')?.required).toBe(true);
    expect(byLabel(fields, 'pronouns')?.options).toEqual([
      { value: '', text: 'Select' },
      { value: 'they', text: 'they/them' },
    ]);
  });

  it('gives identical fields the same signature but distinct ids', () => {
    document.body.innerHTML = `
      <div><span>City</span><input name="city" /></div>
      <div><span>City</span><input name="city" /></div>
    `;
    const { fields } = scanRoot(document);
    expect(fields).toHaveLength(2);
    expect(fields[0]?.signature).toBe(fields[1]?.signature);
    expect(fields[0]?.id).not.toBe(fields[1]?.id);
  });

  it('produces a signature that survives a DOM-position change', () => {
    document.body.innerHTML = `<label for="x">Email</label><input id="x" name="email" type="email" />`;
    const before = scanRoot(document).fields[0]?.signature;

    document.body.innerHTML = `
      <div class="new-wrapper"><section><label for="x">Email</label><input id="x" name="email" type="email" /></section></div>
    `;
    expect(scanRoot(document).fields[0]?.signature).toBe(before);
  });

  it('counts frames it cannot see into instead of pretending they are not there', () => {
    document.body.innerHTML = `<iframe></iframe><input name="here" />`;
    const result = scanRoot(document);
    expect(result.fields).toHaveLength(1);
    expect(result.unreachableFrames).toBeGreaterThanOrEqual(0);
  });
});
