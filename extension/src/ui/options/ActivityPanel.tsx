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
                <th className="pb-2 text-right">Fills</th>
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
      <AccuracySection accuracy={accuracy} />
      <Section
        title="Fill history"
        description="Site, time and counts only. Never the values you submitted."
        action={
          <Button
            variant="danger"
            onClick={() => {
              void sendToBackground('audit:clear').then(refresh);
            }}
          >
            Clear
          </Button>
        }
      >
        <div className="sm:col-span-2">
          {audit.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="pb-2">Site</th>
                  <th className="pb-2">When</th>
                  <th className="pb-2 text-right">✅</th>
                  <th className="pb-2 text-right">⚠️</th>
                  <th className="pb-2 text-right">❌</th>
                  <th className="pb-2 text-right">⬜</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={`${entry.at}-${entry.hostname}`} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-2">
                      {entry.hostname}
                      {entry.adapter && <span className="ml-2 text-xs text-slate-400">{entry.adapter}</span>}
                    </td>
                    <td className="py-2 text-slate-500">{new Date(entry.at).toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{entry.filled}</td>
                    <td className="py-2 text-right tabular-nums">{entry.lowConfidence}</td>
                    <td className="py-2 text-right tabular-nums">{entry.rejected}</td>
                    <td className="py-2 text-right tabular-nums">{entry.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

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
