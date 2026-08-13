import { useCallback, useEffect, useState } from 'react';
import { CANONICAL_KEY_META } from '@autofill/core';
import type { AuditEntryDto, OverrideRecordDto, SiteAccuracyDto } from '@/shared/messages';
import { sendToBackground } from '@/shared/messaging';
import { Button, Card, Section } from '@/ui/components';

/**
 * The local audit log and the learned overrides.
 *
 * ARCHITECTURE.md §6.8: "Every fill records site, timestamp, and field count.
 * Viewable and clearable in the options page." Both lists are local-only and the
 * audit log stores counts, never values.
 */
/**
 * Accuracy tracking (ARCHITECTURE.md §10).
 *
 * "Log per-site fill rate and correction rate locally. If a site's correction
 * rate crosses 20%, its adapter needs work. This turns 'does it work?' into a
 * number."
 *
 * Rates are computed from counts the audit log already holds, so this adds no
 * new data collection — it only reads what §6.8 already records.
 */
function AccuracySection({ accuracy }: { accuracy: SiteAccuracyDto[] }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <Section
      title="Accuracy by site"
      description="How well AutoFill does on each job board. A correction rate above 20% means that site's adapter needs work."
    >
      <div className="sm:col-span-2">
        {accuracy.length === 0 ? (
          <p className="text-sm text-slate-500">No fills recorded yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="pb-2">Site</th>
                <th className="pb-2 text-right">Applications</th>
                <th className="pb-2 text-right">Filled</th>
                <th className="pb-2 text-right">Needs review</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.map((site) => (
                <tr key={site.hostname} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2">
                    {site.hostname}
                    {site.adapter && <span className="ml-2 text-xs text-slate-400">{site.adapter}</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{site.samples}</td>
                  <td className="py-2 text-right tabular-nums">{percent(site.fillRate)}</td>
                  <td
                    className={`py-2 text-right tabular-nums ${
                      site.needsAttention ? 'font-semibold text-amber-600' : ''
                    }`}
                    title={
                      site.needsAttention
                        ? 'Above the 20% threshold — this adapter needs work'
                        : undefined
                    }
                  >
                    {percent(site.correctionRate)}
                    {site.needsAttention ? ' ⚠️' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

/**
 * What the user actually wants to see: the applications, newest first.
 *
 * The audit log used to be listed as raw fill events keyed by hostname, which
 * answered "how is the mapper doing" rather than "what have I applied to". The
 * job title and company were already being scraped for the mapping cascade and
 * then discarded; they are recorded now, and this is what they are for.
 */
function ApplicationsSection({ audit, onClear }: { audit: AuditEntryDto[]; onClear: () => void }) {
  return (
    <Section
      title={audit.length > 0 ? `Applications (${audit.length})` : 'Applications'}
      description="One row per application. Filling the same form again updates its row rather than adding another."
      action={
        audit.length > 0 ? (
          <Button variant="danger" onClick={onClear}>
            Clear
          </Button>
        ) : undefined
      }
    >
      <div className="sm:col-span-2 space-y-2">
        {audit.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing yet. Open a job application and click the AutoFill icon — it will show up here.
          </p>
        ) : (
          audit.map((entry) => (
            <ApplicationRow key={entry.id ?? `${entry.url}-${entry.at}`} entry={entry} />
          ))
        )}
      </div>
    </Section>
  );
}

function ApplicationRow({ entry }: { entry: AuditEntryDto }) {
  const needsReview = entry.lowConfidence + entry.rejected;
  const title = entry.jobTitle ?? entry.company ?? entry.hostname;

  // Never repeat the title in its own subtitle — on a page whose role could not
  // be read, the hostname is already the heading.
  const subtitle = [entry.company, entry.hostname]
    .filter((part): part is string => Boolean(part) && part !== title)
    .join(' · ');

  return (
    <Card className="flex items-start justify-between gap-4 p-3!">
      <div className="min-w-0">
        <a
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-sm font-medium hover:underline"
          title={entry.url}
        >
          {title}
        </a>
        {subtitle && <p className="truncate text-xs text-slate-400">{subtitle}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
          <span>{relativeTime(entry.at)}</span>
          {(entry.fills ?? 1) > 1 && <span>filled {entry.fills}×</span>}
          {entry.adapter && <span className="text-slate-400">{entry.adapter}</span>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {entry.filled} filled
        </span>
        {needsReview > 0 && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            {needsReview} to check
          </span>
        )}
      </div>
    </Card>
  );
}

/** Exact timestamps are noise in a list you scan; the tooltip keeps the detail. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(iso).toLocaleDateString();
}

export function ActivityPanel() {
  const [audit, setAudit] = useState<AuditEntryDto[]>([]);
  const [overrides, setOverrides] = useState<OverrideRecordDto[]>([]);
  const [accuracy, setAccuracy] = useState<SiteAccuracyDto[]>([]);

  const refresh = useCallback(async () => {
    const [entries, learned, rates] = await Promise.all([
      sendToBackground('audit:list', {}),
      sendToBackground('override:list', {}),
      sendToBackground('audit:accuracy'),
    ]);
    setAudit(entries);
    setOverrides(learned);
    setAccuracy(rates);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <ApplicationsSection audit={audit} onClear={() => void sendToBackground('audit:clear').then(refresh)} />
      <AccuracySection accuracy={accuracy} />

      <Section
        title="Learned corrections"
        description="Fixing a field once fixes it forever on that site. Remove one to fall back to automatic mapping."
      >
        <div className="sm:col-span-2 space-y-2">
          {overrides.length === 0 ? (
            <p className="text-sm text-slate-500">No corrections yet.</p>
          ) : (
            overrides.map((override) => (
              <Card key={`${override.hostname}-${override.signature}`} className="flex items-center justify-between gap-4 p-3!">
                <span className="text-sm">
                  <span className="font-medium">{override.hostname}</span>
                  <span className="text-slate-400"> · </span>
                  {override.label ?? override.signature}
                  <span className="text-slate-400"> → </span>
                  <span className="font-medium">{CANONICAL_KEY_META[override.canonicalKey].label}</span>
                </span>
                <Button
                  variant="danger"
                  onClick={() => {
                    void sendToBackground('override:clear', {
                      hostname: override.hostname,
                      signature: override.signature,
                    }).then(refresh);
                  }}
                >
                  Forget
                </Button>
              </Card>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}
