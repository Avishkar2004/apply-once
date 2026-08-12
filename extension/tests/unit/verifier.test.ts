import { beforeEach, describe, expect, it } from 'vitest';
import { summarise, verifyFills } from '@/core/verifier';
import type { FillAttempt } from '@/core/filler';
import { scanRoot } from '@/core/scanner';
import type { FieldDescriptor, FillPlan } from '@/shared/types';

/** ARCHITECTURE.md §3.4 — filled / low confidence / rejected / skipped. */

function registry(): ReadonlyMap<string, FieldDescriptor> {
  return new Map(scanRoot(document).fields.map((field) => [field.id, field]));
}

const emptyPlan: FillPlan = { instructions: [], skipped: [] };

const attempt = (fieldId: string, extra: Partial<FillAttempt> = {}): FillAttempt => ({
  fieldId,
  key: 'personal.firstName',
  intended: 'Ada',
  confidence: 0.95,
  source: 'rule',
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('verifyFills', () => {
  it('marks a value that landed as ✅ filled', () => {
    document.body.innerHTML = `<label for="x">First name</label><input id="x" value="Ada" />`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [attempt(id, { wrote: 'Ada' })]);
    expect(outcome).toMatchObject({ status: 'filled', actual: 'Ada' });
  });

  it('marks a below-threshold mapping as ⚠️ low confidence even when it landed', () => {
    document.body.innerHTML = `<label for="x">First name</label><input id="x" value="Ada" />`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [attempt(id, { wrote: 'Ada', confidence: 0.7 })]);
    expect(outcome?.status).toBe('low-confidence');
  });

  it('marks a value the page reverted as ❌ rejected — the failure that matters', () => {
    document.body.innerHTML = `<label for="x">First name</label><input id="x" value="" />`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [attempt(id, { wrote: 'Ada' })]);
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(outcome?.reason).toMatch(/cleared or overwrote/);
  });

  it('carries a strategy failure straight through as ❌ rejected', () => {
    document.body.innerHTML = `<label for="x">Country</label><select id="x"><option>Alpha</option></select>`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [attempt(id, { error: 'no matching option' })]);
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'no matching option' });
  });

  it('turns plan skips into ⬜ rows with a human reason', () => {
    document.body.innerHTML = `<label for="x">How did you hear about us?</label><input id="x" />`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const outcomes = verifyFills(fields, { instructions: [], skipped: [{ fieldId: id, reason: 'unmapped' }] }, []);
    expect(outcomes[0]).toMatchObject({ status: 'skipped', reason: 'No matching profile field' });
  });

  it('accepts cosmetic reformatting rather than crying wolf', () => {
    document.body.innerHTML = `<label for="x">Phone</label><input id="x" value="(555) 013-4000" />`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [
      attempt(id, { key: 'contact.phone', intended: '5550134000', wrote: '5550134000' }),
    ]);
    expect(outcome?.status).toBe('filled');
  });

  it('reads the checked radio, not the first one', () => {
    document.body.innerHTML = `
      <fieldset><legend>Authorised to work?</legend>
        <label><input type="radio" name="a" value="yes" /> Yes</label>
        <label><input type="radio" name="a" value="no" checked /> No</label>
      </fieldset>`;
    const fields = registry();
    const id = [...fields.keys()][0]!;

    const [outcome] = verifyFills(fields, emptyPlan, [attempt(id, { intended: 'No', wrote: 'No' })]);
    expect(outcome?.actual).toBe('No');
    expect(outcome?.status).toBe('filled');
  });
});

describe('summarise', () => {
  it('counts each bucket', () => {
    const summary = summarise(
      [
        { fieldId: '1', status: 'filled', label: 'a', signature: 's' },
        { fieldId: '2', status: 'filled', label: 'b', signature: 's' },
        { fieldId: '3', status: 'low-confidence', label: 'c', signature: 's' },
        { fieldId: '4', status: 'rejected', label: 'd', signature: 's' },
        { fieldId: '5', status: 'skipped', label: 'e', signature: 's' },
      ],
      1234,
    );
    expect(summary).toEqual({
      filled: 2,
      lowConfidence: 1,
      rejected: 1,
      skipped: 1,
      total: 5,
      durationMs: 1234,
    });
  });
});
