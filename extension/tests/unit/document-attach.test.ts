import { beforeEach, describe, expect, it } from 'vitest';
import { withholdDocuments } from '@/core/session';
import type { FieldDescriptor, FillInstruction, FillPlan } from '@/shared/types';

/**
 * Documents are never attached as a side effect of filling.
 *
 * Found on a live Keka form: the filler attached the résumé, Keka's own parser
 * read it and asked "overwrite the existing data?", answering rewrote the form,
 * the rewrite looked like new content, and the next fill re-attached the file —
 * a dialog the user could not get out of.
 *
 * The same shape exists on Naukri, Workday and SmartRecruiters. Uploading also
 * puts a file on someone else's server, which is a §6.7-sized decision. So a
 * file instruction becomes a button, and the button works exactly once.
 */

function descriptor(id: string, kind: FieldDescriptor['kind']): FieldDescriptor {
  const el = document.createElement(kind === 'file' ? 'input' : 'input');
  if (kind === 'file') el.type = 'file';
  return {
    id,
    signature: `sig-${id}`,
    kind,
    labelBlob: id,
    displayLabel: id,
    required: false,
    el: new WeakRef(el),
  };
}

function instruction(fieldId: string): FillInstruction {
  return {
    fieldId,
    key: 'documents.resume',
    value: { key: 'documents.resume', type: 'file', text: 'cv.pdf', candidates: ['cv.pdf'] },
    confidence: 1,
    source: 'rule',
  };
}

const fields = new Map<string, FieldDescriptor>([
  ['doc', descriptor('doc', 'file')],
  ['name', descriptor('name', 'text')],
]);

let parked: Map<string, FillInstruction>;

beforeEach(() => {
  parked = new Map();
});

const plan = (): FillPlan => ({
  instructions: [instruction('doc'), { ...instruction('name'), key: 'personal.firstName' }],
  skipped: [],
});

describe('withholdDocuments', () => {
  it('never executes a file instruction', () => {
    const held = withholdDocuments(plan(), fields, new Set(), parked);
    expect(held.instructions.map((i) => i.fieldId)).toEqual(['name']);
  });

  it('surfaces the document as a row the user can act on', () => {
    const held = withholdDocuments(plan(), fields, new Set(), parked);
    expect(held.skipped).toEqual([{ fieldId: 'doc', reason: 'needs-attach', key: 'documents.resume' }]);
  });

  it('parks the instruction so the button has something to upload', () => {
    withholdDocuments(plan(), fields, new Set(), parked);
    expect(parked.get('doc')?.value.text).toBe('cv.pdf');
  });

  it('leaves every non-file instruction alone', () => {
    const held = withholdDocuments(plan(), fields, new Set(), parked);
    expect(held.instructions).toHaveLength(1);
    expect(held.instructions[0]?.key).toBe('personal.firstName');
  });

  it('offers nothing once the document is already attached — this is the loop', () => {
    const held = withholdDocuments(plan(), fields, new Set(['sig-doc']), parked);
    expect(held.instructions.some((i) => i.fieldId === 'doc')).toBe(false);
    expect(held.skipped.some((s) => s.fieldId === 'doc')).toBe(false);
  });

  it('keeps the skips the planner already produced', () => {
    const incoming: FillPlan = {
      instructions: [instruction('doc')],
      skipped: [{ fieldId: 'other', reason: 'unmapped' }],
    };
    const held = withholdDocuments(incoming, fields, new Set(), parked);
    expect(held.skipped).toHaveLength(2);
    expect(held.skipped[0]).toEqual({ fieldId: 'other', reason: 'unmapped' });
  });

  it('clears stale parked instructions between fills', () => {
    parked.set('gone', instruction('gone'));
    withholdDocuments(plan(), fields, new Set(), parked);
    expect(parked.has('gone')).toBe(false);
  });
});
