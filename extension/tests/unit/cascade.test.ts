import { describe, expect, it, vi } from 'vitest';
import { FREE_TEXT, UNMAPPABLE, type CanonicalKey, type MappingTarget } from '@autofill/core';
import { runCascade } from '@/core/mapping/cascade';
import { CONFIDENCE, type FieldDescriptorDto } from '@/shared/types';

function field(id: string, labelBlob: string, signature = id): FieldDescriptorDto {
  return { id, signature, kind: 'text', labelBlob, displayLabel: labelBlob, required: false };
}

const empty = new Map<string, CanonicalKey>();

describe('the 4-tier cascade (§3.2)', () => {
  it('exits at Tier 0 on a user override, at confidence 1.00', async () => {
    const fields = [field('f1', 'first name', 'sig-1')];
    const { mappings } = await runCascade(
      { hostname: 'boards.greenhouse.io', fields },
      { overrides: new Map([['sig-1', 'personal.preferredName']]) },
    );

    expect(mappings[0]).toMatchObject({
      target: 'personal.preferredName',
      confidence: CONFIDENCE.override,
      source: 'override',
    });
  });

  it('lets a user override beat the ATS adapter (§3.2, "User overrides win ties")', async () => {
    const fields = [field('f1', 'first name', 'sig-1')];
    const { mappings } = await runCascade(
      {
        hostname: 'jobs.lever.co',
        fields,
        adapterMappings: { f1: 'personal.firstName' },
      },
      { overrides: new Map([['sig-1', 'personal.preferredName']]) },
    );

    expect(mappings[0]?.source).toBe('override');
    expect(mappings[0]?.target).toBe('personal.preferredName');
  });

  it('uses the adapter mapping when there is no override', async () => {
    const { mappings } = await runCascade(
      {
        hostname: 'jobs.lever.co',
        fields: [field('f1', 'some inscrutable label')],
        adapterMappings: { f1: 'contact.email' },
      },
      { overrides: empty },
    );

    expect(mappings[0]).toMatchObject({ target: 'contact.email', source: 'adapter', confidence: 1 });
  });

  it('falls through to Tier 1 rules at confidence 0.95', async () => {
    const { mappings } = await runCascade(
      { hostname: 'x.test', fields: [field('f1', 'email address')] },
      { overrides: empty },
    );
    expect(mappings[0]).toMatchObject({
      target: 'contact.email',
      source: 'rule',
      confidence: CONFIDENCE.rule,
    });
  });

  it('marks anything the shipped tiers cannot place as UNMAPPABLE', async () => {
    const { mappings } = await runCascade(
      { hostname: 'x.test', fields: [field('f1', 'what is your favourite build tool')] },
      { overrides: empty },
    );
    expect(mappings[0]?.target).toBe(UNMAPPABLE);
  });

  it('consults the per-host cache only after the rules miss', async () => {
    const cache = new Map([
      ['sig-known', { canonicalKey: 'contact.email' as CanonicalKey, confidence: 0.7, source: 'llm' as const }],
      ['sig-ruled', { canonicalKey: 'skills' as CanonicalKey, confidence: 0.7, source: 'llm' as const }],
    ]);

    const { mappings } = await runCascade(
      {
        hostname: 'x.test',
        fields: [
          field('f1', 'how should we reach you', 'sig-known'),
          field('f2', 'first name', 'sig-ruled'),
        ],
      },
      { overrides: empty, cache },
    );

    expect(mappings[0]).toMatchObject({ target: 'contact.email', source: 'llm' });
    // The rule wins over the cached lower-confidence guess.
    expect(mappings[1]).toMatchObject({ target: 'personal.firstName', source: 'rule' });
  });

  it('uses Tier 2 when registered, and records it as cacheable', async () => {
    const embeddingMatcher = vi.fn(async (fields: FieldDescriptorDto[]) =>
      new Map(fields.map((f) => [f.id, { key: 'preferences.noticePeriod' as CanonicalKey, score: 0.88 }])),
    );

    const { mappings, cacheable } = await runCascade(
      { hostname: 'x.test', fields: [field('f1', 'how soon could you join', 'sig-1')] },
      { overrides: empty, embeddingMatcher },
    );

    expect(mappings[0]).toMatchObject({ source: 'embedding', confidence: 0.88 });
    expect(cacheable).toEqual([
      { signature: 'sig-1', canonicalKey: 'preferences.noticePeriod', confidence: 0.88, source: 'embedding' },
    ]);
  });

  it('ignores a Tier 2 score below the floor and falls through', async () => {
    const embeddingMatcher = vi.fn(async (fields: FieldDescriptorDto[]) =>
      new Map(fields.map((f) => [f.id, { key: 'skills' as CanonicalKey, score: 0.4 }])),
    );
    const { mappings } = await runCascade(
      { hostname: 'x.test', fields: [field('f1', 'entirely novel question')] },
      { overrides: empty, embeddingMatcher },
    );
    expect(mappings[0]?.target).toBe(UNMAPPABLE);
  });

  it('sends only fields Tier 2 could not place on to Tier 3', async () => {
    const embeddingMatcher = vi.fn(async (fields: FieldDescriptorDto[]) =>
      new Map(
        fields
          .filter((f) => f.id === 'f1')
          .map((f) => [f.id, { key: 'skills' as CanonicalKey, score: 0.9 }]),
      ),
    );
    const llmMatcher = vi.fn(async (fields: FieldDescriptorDto[]) =>
      new Map(fields.map((f) => [f.id, { target: FREE_TEXT as MappingTarget, confidence: 0.7 }])),
    );

    await runCascade(
      {
        hostname: 'x.test',
        fields: [field('f1', 'which tools do you use'), field('f2', 'describe a hard week')],
      },
      { overrides: empty, embeddingMatcher, llmMatcher },
    );

    expect(llmMatcher.mock.calls[0]?.[0].map((f) => f.id)).toEqual(['f2']);
  });

  it('batches every remaining unknown into a single Tier 3 call (§11)', async () => {
    const llmMatcher = vi.fn(async (fields: FieldDescriptorDto[]) =>
      new Map(fields.map((f) => [f.id, { target: 'FREE_TEXT' as const, confidence: 0.6 }])),
    );

    const { mappings } = await runCascade(
      {
        hostname: 'x.test',
        fields: [
          field('f1', 'first name'),
          field('f2', 'why do you want to work here'),
          field('f3', 'describe a challenging project'),
        ],
      },
      { overrides: empty, llmMatcher },
    );

    expect(llmMatcher).toHaveBeenCalledTimes(1);
    expect(llmMatcher.mock.calls[0]?.[0]).toHaveLength(2); // the first name was already mapped
    expect(mappings.filter((m) => m.target === 'FREE_TEXT')).toHaveLength(2);
  });
});
