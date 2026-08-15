import type { FillSession } from '@/shared/types';
import { db, type ApplicationKind, type AuditEntry } from './db';


/**
 * The local audit log (ARCHITECTURE.md §6.8): "Every fill records site,
 * timestamp, and field count. Viewable and clearable in the options page."
 *
 * Counts only. No labels, no values, no mappings — a record of what happened,
 * not a copy of what was submitted. Email applications (§3.7) land in the same
 * table and store the recipient, which is the one identifier that *is* the
 * record: "did I follow up on this one" cannot be answered without it.
 */

const MAX_ENTRIES = 500;

/**
 * Record a fill against the application it belongs to.
 *
 * A repeat fill of the same form updates that application's row rather than
 * appending a new one: correcting one field and re-filling is not a second
 * application, and a history that says otherwise is unreadable after a day's
 * use. `fills` keeps the repetition visible without multiplying rows.
 *
 * Counts are replaced rather than accumulated. The latest fill is the state of
 * the form as the user left it, which is the honest answer to "how did this
 * one go"; summing every attempt would just count corrected fields twice.
 */
export async function recordFill(session: FillSession): Promise<void> {
  const table = db().auditLog;
  const url = stripQuery(session.url);
  const counts = {
    filled: session.summary.filled,
    lowConfidence: session.summary.lowConfidence,
    rejected: session.summary.rejected,
    skipped: session.summary.skipped,
  };

  const existing = await findApplication(url, session.jobTitle, 'form');

  if (existing?.id !== undefined) {
    await table.update(existing.id, {
      ...counts,
      at: session.startedAt,
      fills: (existing.fills ?? 1) + 1,
      firstAt: existing.firstAt ?? existing.at,
      // A later fill may see a title the first one missed — a job board that
      // renders its header late, say. Never overwrite a known value with none.
      ...(session.jobTitle ? { jobTitle: session.jobTitle } : {}),
      ...(session.company ? { company: session.company } : {}),
      ...(session.adapter ? { adapter: session.adapter } : {}),
    });
    return;
  }

  await table.add({
    kind: 'form',
    hostname: session.hostname,
    url,
    ...(session.adapter ? { adapter: session.adapter } : {}),
    ...(session.jobTitle ? { jobTitle: session.jobTitle } : {}),
    ...(session.company ? { company: session.company } : {}),
    at: session.startedAt,
    firstAt: session.startedAt,
    fills: 1,
    ...counts,
  });

  await trimToLimit();
}

/**
 * Record an application made by email (§3.7).
 *
 * Written when the draft appears, not when it is sent — an email AutoFill
 * composed and the user abandoned is still the thing the history exists to
 * remember, and a log that only knows about successes cannot answer "did I ever
 * follow up on this one".
 *
 * Same one-row-per-application rule as `recordFill`: redrafting updates the row
 * and bumps `fills`. Email rows are matched separately from form rows, so a
 * posting that has both a form and an address keeps one of each rather than
 * having the email overwrite the fill counts.
 *
 * Returns the row id, which is what promotes it to `sent` later.
 */
export async function recordEmailApplication(input: EmailApplication): Promise<number> {
  const table = db().auditLog;
  const url = stripQuery(input.url);
  const at = input.at ?? new Date().toISOString();

  const existing = await findApplication(url, input.jobTitle, 'email');

  if (existing?.id !== undefined) {
    await table.update(existing.id, {
      at,
      emailTo: input.to,
      fills: (existing.fills ?? 1) + 1,
      firstAt: existing.firstAt ?? existing.at,
      // A redraft never demotes an application the user already sent.
      emailStatus: existing.emailStatus === 'sent' ? 'sent' : 'drafted',
      ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
      ...(input.company ? { company: input.company } : {}),
    });
    return existing.id;
  }

  const id = await table.add({
    kind: 'email',
    hostname: input.hostname,
    url,
    ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
    ...(input.company ? { company: input.company } : {}),
    at,
    firstAt: at,
    fills: 1,
    emailTo: input.to,
    emailStatus: 'drafted',
    // An email application fills no fields. Zeroes rather than absent so every
    // reader of the table can treat the counts as numbers.
    filled: 0,
    lowConfidence: 0,
    rejected: 0,
    skipped: 0,
  });

  await trimToLimit();
  return id;
}

export interface EmailApplication {
  hostname: string;
  url: string;
  jobTitle?: string;
  company?: string;
  /** The address as it stood when the draft was made. */
  to: string;
  /** Defaults to now. */
  at?: string;
}

/**
 * Mark an email application as sent.
 *
 * "Sent" here means the user clicked one of the send actions — a compose window
 * opened with the draft in it. AutoFill cannot observe the actual send, and
 * claiming otherwise would put a lie in the one view the user trusts. The
 * address is re-recorded because it is editable right up to that click.
 */
export async function markEmailSent(id: number, to?: string): Promise<void> {
  const entry = await db().auditLog.get(id);
  if (!entry) return;

  await db().auditLog.update(id, {
    emailStatus: 'sent',
    sentAt: new Date().toISOString(),
    ...(to ? { emailTo: to } : {}),
  });
}

/** The log is a rolling window, not an archive. */
async function trimToLimit(): Promise<void> {
  const table = db().auditLog;
  const overflow = (await table.count()) - MAX_ENTRIES;
  if (overflow > 0) {
    const stale = await table.orderBy('id').limit(overflow).primaryKeys();
    await table.bulkDelete(stale);
  }
}

/**
 * The row this fill belongs to, if there is one.
 *
 * URL alone is not enough: plenty of boards serve every posting from one path
 * and swap the content, so two different roles would collapse into one row. The
 * scraped job title separates them when it is available.
 *
 * `kind` separates the two ways of applying to the same posting — filling its
 * form and emailing its recruiter are two records, not one overwriting the other.
 */
async function findApplication(
  url: string,
  jobTitle: string | undefined,
  kind: ApplicationKind,
): Promise<AuditEntry | undefined> {
  const candidates = (await db().auditLog.where('url').equals(url).toArray()).filter(
    (entry) => (entry.kind ?? 'form') === kind,
  );
  if (candidates.length === 0) return undefined;

  const sameRole = candidates.find((entry) => (entry.jobTitle ?? '') === (jobTitle ?? ''));
  if (sameRole) return sameRole;

  // This fill could not read a title — a header that renders after the scan,
  // typically. The URL is evidence enough; treat it as the application most
  // recently seen there rather than opening a second row for the same job.
  if (!jobTitle) {
    return candidates.reduce((latest, entry) => (entry.at > latest.at ? entry : latest));
  }

  // A row recorded before the title was readable adopts it now rather than
  // becoming a stranded duplicate.
  return candidates.find((entry) => !entry.jobTitle);
}

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  return db().auditLog.orderBy('at').reverse().limit(limit).toArray();
}

export async function clearAudit(): Promise<void> {
  await db().auditLog.clear();
}

/**
 * Application URLs routinely carry a token or a source tag. The log is for
 * "which site, when, how many fields" — the query string adds nothing to that
 * and can carry an identifier.
 */
function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Accuracy tracking (ARCHITECTURE.md §10).
 *
 * "Log per-site fill rate and correction rate locally. If a site's correction
 * rate crosses 20%, its adapter needs work. This turns 'does it work?' into a
 * number."
 */

/** §10 — above this, the site's adapter needs work. */
export const CORRECTION_RATE_THRESHOLD = 0.2;

/** Below three fills a rate is noise, not a signal. */
export const MIN_SAMPLES_FOR_SIGNAL = 3;

export interface SiteAccuracy {
  hostname: string;
  adapter?: string;
  /** Distinct applications recorded for this host. */
  samples: number;
  /** Fills across those applications — a re-filled form counts each time. */
  fills: number;
  /** filled ÷ every field we saw. */
  fillRate: number;
  /** (low-confidence + rejected) ÷ every field we attempted to fill. */
  correctionRate: number;
  /** True when the rate is both above threshold and backed by enough fills. */
  needsAttention: boolean;
  lastFillAt: string;
}

function summariseHost(hostname: string, entries: AuditEntry[]): SiteAccuracy {
  const totals = entries.reduce(
    (acc, entry) => {
      acc.filled += entry.filled;
      acc.attempted += entry.filled + entry.lowConfidence + entry.rejected;
      acc.seen += entry.filled + entry.lowConfidence + entry.rejected + entry.skipped;
      acc.needsReview += entry.lowConfidence + entry.rejected;
      acc.fills += entry.fills ?? 1;
      return acc;
    },
    { filled: 0, attempted: 0, seen: 0, needsReview: 0, fills: 0 },
  );

  const correctionRate = totals.attempted === 0 ? 0 : totals.needsReview / totals.attempted;
  const adapter = entries.find((entry) => entry.adapter)?.adapter;

  return {
    hostname,
    ...(adapter ? { adapter } : {}),
    samples: entries.length,
    fills: totals.fills,
    fillRate: totals.seen === 0 ? 0 : totals.filled / totals.seen,
    correctionRate,
    needsAttention:
      entries.length >= MIN_SAMPLES_FOR_SIGNAL && correctionRate > CORRECTION_RATE_THRESHOLD,
    lastFillAt: entries.reduce((latest, entry) => (entry.at > latest ? entry.at : latest), ''),
  };
}

/**
 * One row per site, worst correction rate first.
 *
 * Email applications are excluded on purpose: §10 measures how well the mapper
 * does on a site's *form*, and an email row has no fields at all. Averaging its
 * zeroes in would make a site look worse the more of its postings you applied
 * to by email — the opposite of what the number is for.
 */
export async function siteAccuracy(): Promise<SiteAccuracy[]> {
  const entries = (await db().auditLog.toArray()).filter((entry) => isFormEntry(entry));

  const byHost = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const bucket = byHost.get(entry.hostname);
    if (bucket) bucket.push(entry);
    else byHost.set(entry.hostname, [entry]);
  }

  return [...byHost.entries()]
    .map(([hostname, hostEntries]) => summariseHost(hostname, hostEntries))
    .sort((a, b) => b.correctionRate - a.correctionRate || b.samples - a.samples);
}

/** Single-host convenience, same numbers. */
export async function correctionRate(hostname: string): Promise<{ rate: number; samples: number }> {
  const entries = (await db().auditLog.where('hostname').equals(hostname).toArray()).filter(
    (entry) => isFormEntry(entry),
  );
  const summary = summariseHost(hostname, entries);
  return { rate: summary.correctionRate, samples: summary.samples };
}

/** Rows written before v4 carry no `kind`; they were all fills. */
const isFormEntry = (entry: AuditEntry): boolean => (entry.kind ?? 'form') === 'form';
