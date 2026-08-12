import type { FillSession } from '@/shared/types';
import { db, type AuditEntry } from './db';

/**
 * The local audit log (ARCHITECTURE.md §6.8): "Every fill records site,
 * timestamp, and field count. Viewable and clearable in the options page."
 *
 * Counts only. No labels, no values, no mappings — a record of what happened,
 * not a copy of what was submitted.
 */

const MAX_ENTRIES = 500;

export async function recordFill(session: FillSession): Promise<void> {
  const table = db().auditLog;
  await table.add({
    hostname: session.hostname,
    url: stripQuery(session.url),
    ...(session.adapter ? { adapter: session.adapter } : {}),
    at: session.startedAt,
    filled: session.summary.filled,
    lowConfidence: session.summary.lowConfidence,
    rejected: session.summary.rejected,
    skipped: session.summary.skipped,
  });

  const overflow = (await table.count()) - MAX_ENTRIES;
  if (overflow > 0) {
    const stale = await table.orderBy('id').limit(overflow).primaryKeys();
    await table.bulkDelete(stale);
  }
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
  /** Fills recorded for this host. */
  samples: number;
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
      return acc;
    },
    { filled: 0, attempted: 0, seen: 0, needsReview: 0 },
  );

  const correctionRate = totals.attempted === 0 ? 0 : totals.needsReview / totals.attempted;
  const adapter = entries.find((entry) => entry.adapter)?.adapter;

  return {
    hostname,
    ...(adapter ? { adapter } : {}),
    samples: entries.length,
    fillRate: totals.seen === 0 ? 0 : totals.filled / totals.seen,
    correctionRate,
    needsAttention:
      entries.length >= MIN_SAMPLES_FOR_SIGNAL && correctionRate > CORRECTION_RATE_THRESHOLD,
    lastFillAt: entries.reduce((latest, entry) => (entry.at > latest ? entry.at : latest), ''),
  };
}

/** One row per site, worst correction rate first. */
export async function siteAccuracy(): Promise<SiteAccuracy[]> {
  const entries = await db().auditLog.toArray();

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
  const entries = await db().auditLog.where('hostname').equals(hostname).toArray();
  const summary = summariseHost(hostname, entries);
  return { rate: summary.correctionRate, samples: summary.samples };
}
