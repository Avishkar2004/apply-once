import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAudit,
  listAudit,
  markEmailSent,
  recordEmailApplication,
  recordFill,
  siteAccuracy,
} from '@/storage/audit-log';
import { db } from '@/storage/db';
import type { FillSession } from '@/shared/types';

/**
 * Email applications in the history (ARCHITECTURE.md §3.7, §6.8).
 *
 * The Applications view exists to answer one question — what have I applied to
 * — and an answer that only knows about forms is wrong on every posting that
 * takes an email instead. So both kinds share one table.
 *
 * The status matters as much as the row. AutoFill cannot watch a mail client, so
 * "sent" means the user clicked a send action and a compose window opened with
 * the draft in it. An email that was drafted and abandoned stays `drafted`,
 * which is exactly the row worth surfacing later.
 */

const posting = {
  hostname: 'jobs.acme.example',
  url: 'https://jobs.acme.example/roles/backend?utm_source=linkedin',
  jobTitle: 'Backend Engineer',
  company: 'Acme Corp',
  to: 'careers@acme.example',
};

const fill = (extra: Partial<FillSession> = {}): FillSession => ({
  sessionId: crypto.randomUUID(),
  hostname: 'boards.greenhouse.io',
  url: 'https://boards.greenhouse.io/acme/jobs/1',
  jobTitle: 'Data Analyst',
  outcomes: [],
  summary: { filled: 9, lowConfidence: 1, rejected: 0, skipped: 2, total: 12, durationMs: 900 },
  startedAt: new Date().toISOString(),
  ...extra,
});

beforeEach(async () => {
  await clearAudit();
});

describe('recording a drafted email', () => {
  it('creates a row the moment the draft exists, not when it is sent', async () => {
    await recordEmailApplication(posting);

    const [entry] = await listAudit();
    expect(entry?.kind).toBe('email');
    expect(entry?.emailStatus).toBe('drafted');
    expect(entry?.emailTo).toBe('careers@acme.example');
    expect(entry?.sentAt).toBeUndefined();
  });

  it('records the role and company, so the card reads as an application', async () => {
    await recordEmailApplication(posting);

    const [entry] = await listAudit();
    expect(entry?.jobTitle).toBe('Backend Engineer');
    expect(entry?.company).toBe('Acme Corp');
  });

  it('strips the query string, exactly as a fill does (§6.8)', async () => {
    await recordEmailApplication(posting);
    expect((await listAudit())[0]?.url).toBe('https://jobs.acme.example/roles/backend');
  });

  it('counts no fields, because an email application has none', async () => {
    await recordEmailApplication(posting);

    const [entry] = await listAudit();
    expect(entry?.filled).toBe(0);
    expect(entry?.lowConfidence).toBe(0);
    expect(entry?.skipped).toBe(0);
  });
});

describe('redrafting', () => {
  it('updates the same row rather than appending another', async () => {
    await recordEmailApplication(posting);
    await recordEmailApplication(posting);

    const entries = await listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fills).toBe(2);
  });

  it('keeps the address the latest draft was addressed to', async () => {
    await recordEmailApplication(posting);
    await recordEmailApplication({ ...posting, to: 'ada@acme.example' });

    const entries = await listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.emailTo).toBe('ada@acme.example');
  });

  it('remembers when the application was first started', async () => {
    const first = '2026-08-13T09:00:00.000Z';
    const later = '2026-08-13T11:30:00.000Z';

    await recordEmailApplication({ ...posting, at: first });
    await recordEmailApplication({ ...posting, at: later });

    const [entry] = await listAudit();
    expect(entry?.firstAt).toBe(first);
    expect(entry?.at).toBe(later);
  });

  it('never demotes an application the user already sent', async () => {
    const id = await recordEmailApplication(posting);
    await markEmailSent(id);
    await recordEmailApplication(posting);

    expect((await listAudit())[0]?.emailStatus).toBe('sent');
  });

  it('keeps two roles served from one URL apart', async () => {
    await recordEmailApplication({ ...posting, jobTitle: 'Backend Engineer' });
    await recordEmailApplication({ ...posting, jobTitle: 'Data Analyst' });

    expect(await listAudit()).toHaveLength(2);
  });
});

describe('marking one sent', () => {
  it('flips the status and stamps the time', async () => {
    const id = await recordEmailApplication(posting);
    await markEmailSent(id);

    const [entry] = await listAudit();
    expect(entry?.emailStatus).toBe('sent');
    expect(entry?.sentAt).toBeDefined();
    expect(Number.isFinite(Date.parse(entry!.sentAt!))).toBe(true);
  });

  it('takes the address as it stood at the click, which is editable until then', async () => {
    const id = await recordEmailApplication(posting);
    await markEmailSent(id, 'hiring@acme.example');

    expect((await listAudit())[0]?.emailTo).toBe('hiring@acme.example');
  });

  it('does nothing for a row that is no longer there', async () => {
    await expect(markEmailSent(9999)).resolves.toBeUndefined();
  });
});

/**
 * The two kinds coexist. Nothing about the email flow may disturb a history the
 * user already has.
 */
describe('living beside filled forms', () => {
  it('reads existing form rows back unchanged', async () => {
    await recordFill(fill());

    const [entry] = await listAudit();
    expect(entry?.kind).toBe('form');
    expect(entry?.filled).toBe(9);
    expect(entry?.emailTo).toBeUndefined();
  });

  it('backfills `kind` on a row written before the email flow existed', async () => {
    // v3 shape: no `kind` at all. The v4 upgrade fills it in; this asserts the
    // read side agrees, so a partially migrated database still reads as a form.
    await db().auditLog.add({
      hostname: 'legacy.example.com',
      url: 'https://legacy.example.com/apply',
      at: new Date().toISOString(),
      filled: 4,
      lowConfidence: 0,
      rejected: 0,
      skipped: 1,
    } as never);

    const legacy = (await listAudit()).find((entry) => entry.hostname === 'legacy.example.com');
    expect(legacy).toBeDefined();
    // Excluded from nothing, treated as a fill everywhere.
    expect((await siteAccuracy()).map((site) => site.hostname)).toContain('legacy.example.com');
  });

  it('keeps a form row and an email row for the same posting apart', async () => {
    const session = fill({ hostname: 'jobs.acme.example', url: posting.url, jobTitle: posting.jobTitle });
    await recordFill(session);
    await recordEmailApplication(posting);

    const entries = await listAudit();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['email', 'form']);
    // The email did not overwrite the fill counts.
    expect(entries.find((entry) => entry.kind === 'form')?.filled).toBe(9);
  });

  it('leaves email rows out of the §10 accuracy numbers', async () => {
    await recordFill(fill({ hostname: 'jobs.acme.example', url: 'https://jobs.acme.example/f/1' }));
    await recordEmailApplication(posting);

    const [site] = await siteAccuracy();
    // One sample: the fill. An email application has no fields to get right, and
    // averaging its zeroes in would make the site look worse the more postings
    // you applied to by email.
    expect(site?.hostname).toBe('jobs.acme.example');
    expect(site?.samples).toBe(1);
    expect(site?.fillRate).toBeCloseTo(9 / 12);
  });
});
