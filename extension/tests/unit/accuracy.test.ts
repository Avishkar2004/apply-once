import { beforeEach, describe, expect, it } from 'vitest';
import {
  CORRECTION_RATE_THRESHOLD,
  MIN_SAMPLES_FOR_SIGNAL,
  clearAudit,
  listAudit,
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
  // Distinct applications need distinct URLs: a repeat fill of one form updates
  // its row rather than adding another, so re-using a path means "the same job".
  path = '/apply',
): FillSession => ({
  sessionId: crypto.randomUUID(),
  hostname,
  url: `https://${hostname}${path}?token=secret`,
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
      await recordFill(
        session('bad.example.com', { filled: 5, lowConfidence: 3, rejected: 2, skipped: 0 }, undefined, `/apply/${i}`),
      );
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

  it('aggregates several applications on one host', async () => {
    await recordFill(
      session('acme.example.com', { filled: 10, lowConfidence: 0, rejected: 0, skipped: 0 }, undefined, '/jobs/1'),
    );
    await recordFill(
      session('acme.example.com', { filled: 0, lowConfidence: 10, rejected: 0, skipped: 0 }, undefined, '/jobs/2'),
    );

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

/**
 * The history is a list of applications, not a list of fills.
 *
 * Correcting one field and re-filling is not a second application. Recording it
 * as one made the Activity tab unreadable after a day's use, and buried the
 * thing the user opened it for: which jobs have I applied to.
 */
describe('one row per application', () => {
  const apply = (
    counts: { filled: number; lowConfidence: number; rejected: number; skipped: number },
    extra: Partial<FillSession> = {},
  ): FillSession => ({
    sessionId: crypto.randomUUID(),
    hostname: 'smartdocs.keka.com',
    url: 'https://smartdocs.keka.com/careers/applyjob/136647?src=linkedin',
    outcomes: [],
    summary: { ...counts, total: 0, durationMs: 1000 },
    startedAt: new Date().toISOString(),
    ...extra,
  });

  it('updates the row instead of appending when the same form is filled again', async () => {
    await recordFill(apply({ filled: 8, lowConfidence: 2, rejected: 0, skipped: 4 }));
    await recordFill(apply({ filled: 12, lowConfidence: 0, rejected: 0, skipped: 2 }));

    const entries = await listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fills).toBe(2);
  });

  it('keeps the latest counts, which are how the user left the form', async () => {
    await recordFill(apply({ filled: 8, lowConfidence: 2, rejected: 0, skipped: 4 }));
    await recordFill(apply({ filled: 12, lowConfidence: 0, rejected: 0, skipped: 2 }));

    const [entry] = await listAudit();
    expect(entry?.filled).toBe(12);
    expect(entry?.lowConfidence).toBe(0);
  });

  it('remembers when the application was first started', async () => {
    const first = new Date('2026-08-13T09:00:00.000Z').toISOString();
    const later = new Date('2026-08-13T11:30:00.000Z').toISOString();

    await recordFill(apply({ filled: 1, lowConfidence: 0, rejected: 0, skipped: 0 }, { startedAt: first }));
    await recordFill(apply({ filled: 3, lowConfidence: 0, rejected: 0, skipped: 0 }, { startedAt: later }));

    const [entry] = await listAudit();
    expect(entry?.firstAt).toBe(first);
    expect(entry?.at).toBe(later);
  });

  it('records the role and company, not just the hostname', async () => {
    await recordFill(
      apply({ filled: 5, lowConfidence: 0, rejected: 0, skipped: 0 }, {
        jobTitle: 'Senior Software Engineer',
        company: 'Keka',
      }),
    );

    const [entry] = await listAudit();
    expect(entry?.jobTitle).toBe('Senior Software Engineer');
    expect(entry?.company).toBe('Keka');
  });

  it('keeps two different roles served from one URL apart', async () => {
    // Single-page job boards swap the posting without changing the path.
    await recordFill(apply({ filled: 5, lowConfidence: 0, rejected: 0, skipped: 0 }, { jobTitle: 'Backend Engineer' }));
    await recordFill(apply({ filled: 5, lowConfidence: 0, rejected: 0, skipped: 0 }, { jobTitle: 'Data Analyst' }));

    expect(await listAudit()).toHaveLength(2);
  });

  it('adopts a title the first fill could not read rather than duplicating the row', async () => {
    // A board that renders its header late gives the first scan no title.
    await recordFill(apply({ filled: 5, lowConfidence: 0, rejected: 0, skipped: 0 }));
    await recordFill(apply({ filled: 6, lowConfidence: 0, rejected: 0, skipped: 0 }, { jobTitle: 'Backend Engineer' }));

    const entries = await listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobTitle).toBe('Backend Engineer');
  });

  it('never lets a later fill erase a title it failed to read', async () => {
    await recordFill(apply({ filled: 5, lowConfidence: 0, rejected: 0, skipped: 0 }, { jobTitle: 'Backend Engineer' }));
    await recordFill(apply({ filled: 6, lowConfidence: 0, rejected: 0, skipped: 0 }));

    const entries = await listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobTitle).toBe('Backend Engineer');
  });

  it('still strips the query string from the recorded URL (§6.8)', async () => {
    await recordFill(apply({ filled: 1, lowConfidence: 0, rejected: 0, skipped: 0 }));
    const [entry] = await listAudit();
    expect(entry?.url).toBe('https://smartdocs.keka.com/careers/applyjob/136647');
  });
});
