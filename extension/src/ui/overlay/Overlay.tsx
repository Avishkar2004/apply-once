import { useMemo, useState, type ReactNode } from 'react';
import type { CanonicalKey } from '@autofill/core';
import type { FillOutcome, FillSession, FillSummary } from '@/shared/types';
import { KeyPicker } from './KeyPicker';

/**
 * The review overlay (ARCHITECTURE.md §3.5).
 *
 * The panel is ranked, not listed. A real application form has forty controls
 * and the user cares about three of them, so the layout is:
 *
 *   1. a header that answers "did it work?" without reading — a proportion bar
 *      and four counts;
 *   2. **Needs you** — the handful that failed or landed low-confidence, open;
 *   3. everything else folded away behind a disclosure, with counts.
 *
 * Page furniture that could never hold profile data — captchas, consent
 * paragraphs, currency prefixes — is summarised as a tally instead of getting a
 * row each. See `isFurniture`.
 *
 * "Never auto-submits" sits in the footer on every render — it is the product's
 * central promise, not a preference.
 */

export type OverlayPhase =
  | { kind: 'idle' }
  | { kind: 'filling'; done: number; total: number }
  | { kind: 'done'; session: FillSession }
  | { kind: 'locked' }
  | { kind: 'error'; message: string };

export interface OverlayProps {
  phase: OverlayPhase;
  unreachableFrames: number;
  onClose: () => void;
  onRefill: () => void;
  onHighlight: (fieldId: string) => void;
  onCorrect: (outcome: FillOutcome, key: CanonicalKey) => Promise<void>;
  onOpenOptions: () => void;
  /** Free-text questions (§3.6). Returns a draft; never writes to the page. */
  onDraft: (outcome: FillOutcome) => Promise<{ answer: string; source: 'bank' | 'llm' }>;
  /** The approval click — the only path from a draft to the form. */
  onAcceptDraft: (outcome: FillOutcome, answer: string) => Promise<boolean>;
  /** The one-click upload — the only path from a stored document to the form. */
  onAttach: (outcome: FillOutcome) => Promise<{ ok: boolean; detail: string }>;
}

export function Overlay(props: OverlayProps) {
  const { phase } = props;

  return (
    <div className="panel" role="dialog" aria-label="AutoFill review">
      <Header {...props} />
      {phase.kind === 'filling' && <FillingBody done={phase.done} total={phase.total} />}
      {phase.kind === 'locked' && <LockedBody onOpenOptions={props.onOpenOptions} />}
      {phase.kind === 'error' && <ErrorBody message={phase.message} onRefill={props.onRefill} />}
      {phase.kind === 'done' && <ResultBody session={phase.session} {...props} />}
      <Footer {...props} />
    </div>
  );
}

function Header({ phase, onClose }: OverlayProps) {
  const session = phase.kind === 'done' ? phase.session : undefined;
  const s = session?.summary;
  const total = Math.max(s?.total ?? 0, 1);
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;

  return (
    // The grab handle. `drag.ts` looks for this attribute, not the class name.
    <div className="head" data-autofill-drag title="Drag to move">
      <div className="brand">
        <span className="grip" aria-hidden />
        <span className="brand-mark" aria-hidden>
          A
        </span>
        <span className="brand-name">AutoFill</span>
        <span className="brand-host" title={session?.hostname}>
          {session ? `${session.hostname}${session.adapter ? ` · ${session.adapter}` : ''}` : ''}
        </span>
        <button className="icon-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {s && (
        <>
          <div className="meter" role="img" aria-label={`${s.filled} of ${s.total} fields filled`}>
            {s.filled > 0 && <span className="meter-ok" style={{ width: pct(s.filled) }} />}
            {s.lowConfidence > 0 && <span className="meter-warn" style={{ width: pct(s.lowConfidence) }} />}
            {s.rejected > 0 && <span className="meter-bad" style={{ width: pct(s.rejected) }} />}
            {s.skipped > 0 && <span className="meter-idle" style={{ width: pct(s.skipped) }} />}
          </div>

          <div className="stats">
            <Stat tone="ok" n={s.filled} label="filled" />
            {s.lowConfidence > 0 && <Stat tone="warn" n={s.lowConfidence} label="check" />}
            {s.rejected > 0 && <Stat tone="bad" n={s.rejected} label="failed" />}
            <Stat tone="idle" n={s.skipped} label="skipped" />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ tone, n, label }: { tone: string; n: number; label: string }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-n">{n}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

function FillingBody({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="notice">
      <strong>Filling {total} fields…</strong>
      <div className="progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="muted">
        {done} of {total}
      </span>
    </div>
  );
}

function LockedBody({ onOpenOptions }: { onOpenOptions: () => void }) {
  return (
    <div className="notice">
      <strong>AutoFill is locked</strong>
      <span className="muted">
        Your profile is encrypted on this device. Unlock it to fill this application.
      </span>
      <button className="btn btn-primary" onClick={onOpenOptions}>
        Unlock AutoFill
      </button>
    </div>
  );
}

function ErrorBody({ message, onRefill }: { message: string; onRefill: () => void }) {
  return (
    <div className="notice">
      <strong>Could not fill this page</strong>
      <span className="muted">{message}</span>
      <button className="btn" onClick={onRefill}>
        Try again
      </button>
    </div>
  );
}

/**
 * Is this row page furniture rather than a question about the applicant?
 *
 * Every form carries controls that no profile could ever fill: a captcha, a
 * consent paragraph rendered as a checkbox label, a currency prefix beside a
 * salary box, a bare "Select" placeholder. Giving each of them a row with
 * "No matching profile field" and a key picker buries the two rows that
 * actually need a decision.
 *
 * The test only ever *demotes*, and only ever within the skipped group:
 *
 *  - a failure is never furniture, whatever it is called;
 *  - a free-text question is never furniture — it has a draft flow;
 *  - a `needs-attach` row is never furniture — it has a button.
 *
 * Demoted rows are still counted, and the tally naming them stays visible, so
 * nothing disappears silently.
 */
const FURNITURE_LABEL =
  /\b(captcha|recaptcha|i (agree|accept|consent)|privacy policy|terms (and|&) conditions|declaration|hereby|data processing)\b|^[swd]\/o$/i;

/** A placeholder or a unit, not a question. */
const NOT_A_QUESTION = /^(select|choose|none|n\/?a|inr|usd|rs\.?|₹|\$|—|–|-|\*)$/i;

/**
 * Which end state the panel is reporting.
 *
 * Split out because getting it wrong is not a cosmetic matter: a session that
 * found no form at all shares every count with one that filled everything, and
 * reporting "Everything mapped cleanly — 0 fields" for the first tells the user
 * their empty page was a success.
 */
export function summaryHeadline(summary: FillSummary): 'no-fields' | 'nothing-filled' | 'filled' {
  if (summary.total === 0) return 'no-fields';
  if (summary.filled === 0) return 'nothing-filled';
  return 'filled';
}

export function isFurniture(outcome: FillOutcome): boolean {
  if (outcome.status !== 'skipped') return false;
  if (outcome.skipReason === 'free-text' || outcome.skipReason === 'needs-attach') return false;

  const label = outcome.label.trim();
  if (label.length < 2) return true;
  if (NOT_A_QUESTION.test(label)) return true;
  if (FURNITURE_LABEL.test(label)) return true;
  // A sentence is a disclosure the user must read and tick, not a field label.
  if (label.length > 90) return true;
  return false;
}

function ResultBody({
  session,
  unreachableFrames,
  onHighlight,
  onCorrect,
  onDraft,
  onAcceptDraft,
  onAttach,
  onOpenOptions,
  onRefill,
}: { session: FillSession } & OverlayProps) {
  const groups = useMemo(() => {
    const attention: FillOutcome[] = [];
    const filled: FillOutcome[] = [];
    const idle: FillOutcome[] = [];
    let furniture = 0;

    for (const outcome of session.outcomes) {
      if (outcome.status === 'filled') filled.push(outcome);
      else if (outcome.status !== 'skipped') attention.push(outcome);
      else if (isFurniture(outcome)) furniture += 1;
      else idle.push(outcome);
    }

    // Things with an action attached come first within their group.
    const actionable = (o: FillOutcome) =>
      o.skipReason === 'needs-attach' ? 0 : o.skipReason === 'free-text' ? 1 : 2;
    idle.sort((a, b) => actionable(a) - actionable(b));

    return { attention, filled, idle, furniture };
  }, [session]);

  const rowProps = { onHighlight, onCorrect, onDraft, onAcceptDraft, onAttach };
  const nothingLeft = groups.attention.length === 0 && groups.idle.length === 0;
  const { filled, total, durationMs } = session.summary;
  const headline = summaryHeadline(session.summary);

  // There was no form. "Everything mapped cleanly — 0 fields" congratulates the
  // user for nothing and hides the two things that actually cause this: the
  // form has not mounted yet, or it is inside a frame we cannot reach.
  if (headline === 'no-fields') {
    return (
      <div className="notice">
        <strong>No form fields here</strong>
        <span className="muted">
          AutoFill found nothing to fill on this page. If the application form is still loading, or you
          have not opened it yet, scan again once it is on screen.
        </span>
        {unreachableFrames > 0 && (
          <span className="muted">
            {unreachableFrames} embedded {unreachableFrames === 1 ? 'frame' : 'frames'} could not be read
            — the form may well be inside {unreachableFrames === 1 ? 'it' : 'them'}.
          </span>
        )}
        <div className="row-actions">
          <button className="btn btn-primary" onClick={onRefill}>
            Scan again
          </button>
          <button className="btn" onClick={onOpenOptions}>
            Open my profile
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="body">
      {/* Fields exist but nothing went in — almost always an empty profile,
          which is worth saying plainly and offering a way to fix. */}
      {headline === 'nothing-filled' && (
        <div className="notice">
          <strong>Nothing was filled</strong>
          <span className="muted">
            AutoFill read {total} field{total === 1 ? '' : 's'} here but your profile had nothing to put
            in {total === 1 ? 'it' : 'them'}. Fill your details in once and this page fills itself.
          </span>
          <button className="btn btn-primary" onClick={onOpenOptions}>
            Open my profile
          </button>
        </div>
      )}
      {nothingLeft && headline === 'filled' && (
        <div className="notice">
          <strong>Everything mapped cleanly.</strong>
          <span className="muted">
            {filled} field{filled === 1 ? '' : 's'} in {(durationMs / 1000).toFixed(1)}s. Read them over
            before you submit.
          </span>
        </div>
      )}

      {groups.attention.length > 0 && (
        <Section title="Needs you" count={groups.attention.length}>
          {groups.attention.map((outcome) => (
            <Row key={outcome.fieldId} outcome={outcome} {...rowProps} />
          ))}
        </Section>
      )}

      {groups.filled.length > 0 && (
        <Fold title="Filled" count={groups.filled.length}>
          {groups.filled.map((outcome) => (
            <div
              key={outcome.fieldId}
              className="row row-compact row-filled"
              onClick={() => onHighlight(outcome.fieldId)}
            >
              <span className="row-label">{outcome.label}</span>
              {outcome.actual ? <span className="value">{outcome.actual}</span> : null}
            </div>
          ))}
        </Fold>
      )}

      {groups.idle.length > 0 && (
        <Fold title="Nothing to fill" count={groups.idle.length}>
          {groups.idle.map((outcome) => (
            <Row key={outcome.fieldId} outcome={outcome} {...rowProps} />
          ))}
        </Fold>
      )}

      {(groups.furniture > 0 || unreachableFrames > 0) && (
        <div className="tail">
          {groups.furniture > 0 && (
            <div>
              {groups.furniture} more {groups.furniture === 1 ? 'control' : 'controls'} on this page hold
              nothing about you — captcha, consent and the like.
            </div>
          )}
          {unreachableFrames > 0 && (
            <div>
              {unreachableFrames} embedded {unreachableFrames === 1 ? 'frame' : 'frames'} could not be read —
              anything inside {unreachableFrames === 1 ? 'it' : 'them'} needs filling by hand.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="section-head">
        <span>{title}</span>
        <span className="section-n">{count}</span>
      </div>
      {children}
    </section>
  );
}

/** A collapsed group. Native `<details>`, so it is keyboard accessible for free. */
function Fold({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <details className="fold">
      <summary className="section-head">
        <span className="summary-label">
          <span className="chev" aria-hidden>
            ›
          </span>
          {title}
        </span>
        <span className="section-n">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function Row({
  outcome,
  onHighlight,
  onCorrect,
  onDraft,
  onAcceptDraft,
  onAttach,
}: {
  outcome: FillOutcome;
  onHighlight: (fieldId: string) => void;
  onCorrect: (outcome: FillOutcome, key: CanonicalKey) => Promise<void>;
  onDraft: OverlayProps['onDraft'];
  onAcceptDraft: OverlayProps['onAcceptDraft'];
  onAttach: OverlayProps['onAttach'];
}) {
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const correct = async (key: CanonicalKey) => {
    setBusy(true);
    try {
      await onCorrect(outcome, key);
    } finally {
      setBusy(false);
    }
  };

  // A free-text question is answered, not mapped — it gets the draft flow
  // instead of the canonical-key picker (§3.6). A document is attached, not
  // typed, so it gets a button instead of either.
  const isFreeText = outcome.skipReason === 'free-text';
  const isDocument = outcome.skipReason === 'needs-attach';

  return (
    <div className={`row row-${outcome.status}`} onClick={() => onHighlight(outcome.fieldId)}>
      <div className="row-head">
        <span className="row-label">{outcome.label}</span>
        {outcome.status !== 'skipped' && !accepted && (
          <span className="row-actions">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setAccepted(true);
              }}
              title="Looks right"
            >
              ✓
            </button>
          </span>
        )}
      </div>

      {outcome.actual ? <div className="value">{outcome.actual}</div> : null}
      {outcome.reason && <span className="muted">{outcome.reason}</span>}

      {isDocument ? (
        <AttachButton outcome={outcome} onAttach={onAttach} />
      ) : isFreeText ? (
        <DraftEditor outcome={outcome} onDraft={onDraft} onAcceptDraft={onAcceptDraft} />
      ) : (
        (outcome.status === 'skipped' || outcome.status === 'rejected' || !accepted) && (
          <KeyPicker value={outcome.key} disabled={busy} onChange={(key) => void correct(key)} />
        )
      )}
    </div>
  );
}

/**
 * Upload a stored document, once, on purpose.
 *
 * Filling never attaches a file on its own: most job boards run their own
 * résumé parser the moment one lands and then offer to overwrite the form,
 * which turns an unattended upload into a dialog the user cannot get out of.
 * See `withholdDocuments` in `core/session`.
 */
function AttachButton({
  outcome,
  onAttach,
}: {
  outcome: FillOutcome;
  onAttach: OverlayProps['onAttach'];
}) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'failed'; detail?: string }>({
    kind: 'idle',
  });

  if (state.kind === 'done') {
    return <span className="muted">✓ Attached {state.detail}</span>;
  }

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <button
        className="btn btn-primary"
        disabled={state.kind === 'busy'}
        onClick={() => {
          setState({ kind: 'busy' });
          void onAttach(outcome).then((result) =>
            setState({ kind: result.ok ? 'done' : 'failed', detail: result.detail }),
          );
        }}
      >
        {state.kind === 'busy' ? 'Attaching…' : 'Attach my document'}
      </button>
      {state.kind === 'failed' && <span className="muted">{state.detail}</span>}
    </div>
  );
}

/**
 * The free-text draft flow (ARCHITECTURE.md §3.6).
 *
 * "Drafts are **never** filled silently. They land in the overlay marked ⚠️ and
 * require one click to accept." The draft is editable before that click, and
 * accepting is also what stores it in the Answer Bank.
 */
function DraftEditor({
  outcome,
  onDraft,
  onAcceptDraft,
}: {
  outcome: FillOutcome;
  onDraft: OverlayProps['onDraft'];
  onAcceptDraft: OverlayProps['onAcceptDraft'];
}) {
  const [draft, setDraft] = useState<string | undefined>();
  const [source, setSource] = useState<'bank' | 'llm' | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [used, setUsed] = useState(false);

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await onDraft(outcome);
      setDraft(result.answer);
      setSource(result.source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setUsed(await onAcceptDraft(outcome, draft));
    } finally {
      setBusy(false);
    }
  };

  if (used) return <span className="muted">✓ Answer written. Review it before you submit.</span>;

  return (
    <div onClick={(event) => event.stopPropagation()}>
      {draft === undefined ? (
        <button className="btn" disabled={busy} onClick={() => void generate()}>
          {busy ? 'Drafting…' : 'Draft an answer'}
        </button>
      ) : (
        <>
          <textarea
            className="draft"
            rows={5}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="row-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void accept()}>
              Use this answer
            </button>
            <button className="btn" disabled={busy} onClick={() => void generate()}>
              Redraft
            </button>
          </div>
          <span className="muted">
            {source === 'bank'
              ? 'Reused from your answer bank.'
              : 'AI draft — edit it before you use it.'}
          </span>
        </>
      )}
      {error && <span className="muted">{error}</span>}
    </div>
  );
}

function Footer({ phase, onRefill, onOpenOptions }: OverlayProps) {
  return (
    <div className="foot">
      <span className="pledge">
        <span aria-hidden>🔒</span> Never submits for you
      </span>
      {/* The panel used to be a dead end: whatever it reported, there was no way
          from here to the profile that would fix it. */}
      <span className="row-actions">
        <button className="btn btn-ghost" onClick={onOpenOptions} title="Edit your profile and settings">
          Profile
        </button>
        <button className="btn" onClick={onRefill} disabled={phase.kind === 'filling'}>
          Re-fill
        </button>
      </span>
    </div>
  );
}
