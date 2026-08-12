import { beforeEach, describe, expect, it } from 'vitest';
import {
  CORRECTION_RATE_THRESHOLD,
  MIN_SAMPLES_FOR_SIGNAL,
  clearAudit,
  correctionRate,
  recordFill,
  siteAccuracy,
} from '@/storage/audit-log';
import type { FillSession } from '@/shared/types';

/**
 * Accuracy tracking (ARCHITECTURE.md §10).
 *
 * "If a site's correction rate crosses 20%, its adapter needs work. This turns
 * 'does it work?' into a number."
 */

const session = (
  hostname: string,
  counts: { filled: number; lowConfidence: number; rejected: number; skipped: number },
  adapter?: string,
): FillSession => ({
  sessionId: crypto.randomUUID(),
  hostname,
  url: `https://${hostname}/apply?token=secret`,
  ...(adapter ? { adapter } : {}),
  outcomes: [],
  summary: { ...counts, total: 0, durationMs: 1000 },
  startedAt: new Date().toISOString(),
});

beforeEach(async () => {
  await clearAudit();
});

describe('siteAccuracy', () => {
  it('computes fill and correction rates per site', async () => {
    await recordFill(
      session('boards.greenhouse.io', { filled: 8, lowConfidence: 1, rejected: 1, skipped: 2 }, 'greenhouse'),
    );

    const [site] = await siteAccuracy();
    expect(site?.hostname).toBe('boards.greenhouse.io');
    expect(site?.adapter).toBe('greenhouse');
    // 8 filled out of 12 seen.
    expect(site?.fillRate).toBeCloseTo(8 / 12);
    // 2 needing review out of 10 attempted.
    expect(site?.correctionRate).toBeCloseTo(0.2);
  });

  it('flags a site above the 20% threshold once there is enough signal', async () => {
    for (let i = 0; i < MIN_SAMPLES_FOR_SIGNAL; i += 1) {
      await recordFill(session('bad.example.com', { filled: 5, lowConfidence: 3, rejected: 2, skipped: 0 }));
    }

    const [site] = await siteAccuracy();
    expect(site?.correctionRate).toBeGreaterThan(CORRECTION_RATE_THRESHOLD);
    expect(site?.needsAttention).toBe(true);
  });

  it('does not flag a site on a single bad fill', async () => {
    await recordFill(session('new.example.com', { filled: 1, lowConfidence: 5, rejected: 0, skipped: 0 }));

    const [site] = await siteAccuracy();
    expect(site?.correctionRate).toBeGreaterThan(CORRECTION_RATE_THRESHOLD);
    // One sample is noise, not a verdict on the adapter.
    expect(site?.needsAttention).toBe(false);
  });

  it('sorts the worst sites first', async () => {
    await recordFill(session('good.example.com', { filled: 10, lowConfidence: 0, rejected: 0, skipped: 0 }));
    await recordFill(session('bad.example.com', { filled: 2, lowConfidence: 6, rejected: 2, skipped: 0 }));

    expect((await siteAccuracy()).map((site) => site.hostname)).toEqual([
      'bad.example.com',
      'good.example.com',
    ]);
  });

  it('aggregates several fills on one host', async () => {
    await recordFill(session('acme.example.com', { filled: 10, lowConfidence: 0, rejected: 0, skipped: 0 }));
    await recordFill(session('acme.example.com', { filled: 0, lowConfidence: 10, rejected: 0, skipped: 0 }));

    const [site] = await siteAccuracy();
    expect(site?.samples).toBe(2);
    expect(site?.correctionRate).toBeCloseTo(0.5);
  });

  it('reports zero rather than NaN for a site with nothing attempted', async () => {
    await recordFill(session('empty.example.com', { filled: 0, lowConfidence: 0, rejected: 0, skipped: 4 }));

    const [site] = await siteAccuracy();
    expect(site?.correctionRate).toBe(0);
    expect(site?.fillRate).toBe(0);
  });

  it('agrees with the single-host helper', async () => {
    await recordFill(session('acme.example.com', { filled: 6, lowConfidence: 2, rejected: 2, skipped: 0 }));

    const [site] = await siteAccuracy();
    const single = await correctionRate('acme.example.com');
    expect(single.rate).toBeCloseTo(site!.correctionRate);
    expect(single.samples).toBe(site!.samples);
  });
});

describe('audit privacy (§6.8)', () => {
  it('stores counts and a query-free URL, never field values', async () => {
    await recordFill(session('acme.example.com', { filled: 3, lowConfidence: 0, rejected: 0, skipped: 0 }));

    const { listAudit } = await import('@/storage/audit-log');
    const [entry] = await listAudit();

    expect(entry?.url).toBe('https://acme.example.com/apply');
    expect(JSON.stringify(entry)).not.toContain('secret');
  });
});
