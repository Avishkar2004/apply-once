import { useMemo, useState, type ReactNode } from 'react';
import type { CanonicalKey } from '@autofill/core';
import type { DraftEmailResponse } from '@/shared/messages';
import type { FillOutcome, FillSession, FillSummary } from '@/shared/types';
import type { EmailDetection } from '@/core/email/detect';
import type { ComposedEmail, SendMethod } from '@/core/email/send';
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
  /**
   * The address this page offers, when it has one (§3.7). Present or absent —
   * a page with no address changes nothing about the panel.
   */
  email?: EmailDetection;
  /** Composes the email and records it as drafted. Never sends. */
  onDraftEmail: (to: string) => Promise<DraftEmailResponse>;
  /** The send click — opens a compose window; the user still presses send. */
  onSendEmail: (method: SendMethod, email: ComposedEmail, entryId: number) => Promise<boolean>;
  /** Downloads a stored document so it can be attached by hand. */
  onDownloadDocument: (blobId: string) => Promise<{ ok: boolean; detail: string }>;
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
  email,
  onDraftEmail,
  onSendEmail,
  onDownloadDocument,
  onHighlight,
  onCorrect,
  onDraft,
  onAcceptDraft,
  onAttach,
  onOpenOptions,
  onRefill,
}: { session: FillSession } & OverlayProps) {
  // `onOpenOptions` travels with them: when a draft comes back empty the cause
  // is almost always a setting, and a notice with no way to act on it is half a
  // message. The "Nothing was filled" notice has offered this route for a while.
  const emailProps = { onDraftEmail, onSendEmail, onDownloadDocument, onOpenOptions };
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
  // user for nothing and hides the three things that actually cause this: the
  // form has not mounted yet, it is inside a frame we cannot reach — or there is
  // no form at all and the posting wants an email (§3.7).
  if (headline === 'no-fields') {
    return (
      <div className="body">
        <div className="notice">
          <strong>{email ? 'This posting takes email applications' : 'No form fields here'}</strong>
          <span className="muted">
            {email
              ? 'There is no application form on this page, but there is an address. AutoFill can write the email; you review it and send it yourself.'
              : 'AutoFill found nothing to fill on this page. If the application form is still loading, or you have not opened it yet, scan again once it is on screen.'}
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
        {email && <EmailApply detection={email} {...emailProps} />}
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

      {/* Reached when the page has a control or two — a search box, a newsletter
          input — but nothing that amounts to an application form. Folded rather
          than prominent: the panel has already reported on the fields it found,
          and this is the alternative, not the headline. */}
      {email && (
        <Fold title="Apply by email instead" count={1}>
          <EmailApply detection={email} {...emailProps} />
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

  // A question is answered, not mapped (§3.6). A document is attached, not
  // typed. Both get something other than the canonical-key picker.
  //
  // `unmapped` counts as a question too: a screener like "Do you have your own
  // laptop which you can use for work?" has no canonical key and never will,
  // and offering only a list of profile fields for it was a dead end.
  const isDocument = outcome.skipReason === 'needs-attach';
  const isQuestion = outcome.skipReason === 'free-text' || outcome.skipReason === 'unmapped';

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

      {isDocument && <AttachButton outcome={outcome} onAttach={onAttach} />}

      {isQuestion && (
        <AnswerControl outcome={outcome} onDraft={onDraft} onAcceptDraft={onAcceptDraft} />
      )}

      {/* Still offer the profile mapping for an unmapped field — it may simply
          be a field the cascade missed rather than a question. A `free-text`
          field has already been judged prose, so it gets no picker. */}
      {!isDocument &&
        outcome.skipReason !== 'free-text' &&
        (outcome.status === 'skipped' || outcome.status === 'rejected' || !accepted) && (
          <KeyPicker value={outcome.key} disabled={busy} onChange={(key) => void correct(key)} />
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
 * Answer a question the profile cannot hold, once.
 *
 * Job boards ask screener questions no schema could anticipate — "Do you have
 * your own laptop which you can use for work?", "Are you open to night shifts?"
 * — and Naukri asks the same handful on every posting. They were reported as
 * "No matching profile field" with a list of profile fields to pick from, none
 * of which fitted, which is a dead end dressed as a choice.
 *
 * Answering here writes to the page *and* to the answer bank, so the next
 * application that asks the same thing fills it without being asked (§3.6).
 * The control follows the field: buttons for a set of options, Yes/No for a
 * checkbox, the AI draft flow for an essay box, a text field otherwise.
 */
function AnswerControl({
  outcome,
  onDraft,
  onAcceptDraft,
}: {
  outcome: FillOutcome;
  onDraft: OverlayProps['onDraft'];
  onAcceptDraft: OverlayProps['onAcceptDraft'];
}) {
  const [saved, setSaved] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  const submit = async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      if (await onAcceptDraft(outcome, trimmed)) setSaved(trimmed);
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return <span className="muted">✓ “{saved}” — saved, and reused next time you are asked.</span>;
  }

  // An essay keeps the drafting flow; a one-word answer does not need a model.
  if (outcome.kind === 'textarea') {
    return <DraftEditor outcome={outcome} onDraft={onDraft} onAcceptDraft={onAcceptDraft} />;
  }

  const choices =
    outcome.options && outcome.options.length > 0 && outcome.options.length <= 8
      ? outcome.options.map((option) => option.text)
      : outcome.kind === 'checkbox' || outcome.kind === 'radio-group'
        ? ['Yes', 'No']
        : undefined;

  return (
    <div className="answer" onClick={(event) => event.stopPropagation()}>
      {choices ? (
        <div className="row-actions">
          {choices.map((choice) => (
            <button key={choice} className="btn" disabled={busy} onClick={() => void submit(choice)}>
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <div className="row-actions">
          <input
            className="answer-input"
            value={typed}
            disabled={busy}
            placeholder="Type your answer"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit(typed);
            }}
          />
          <button
            className="btn btn-primary"
            disabled={busy || !typed.trim()}
            onClick={() => void submit(typed)}
          >
            Save
          </button>
        </div>
      )}
      <span className="muted">Answered once, then reused on every site that asks it.</span>
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

/**
 * Apply by email (ARCHITECTURE.md §3.7).
 *
 * The same contract as every other write in this panel: AutoFill produces text,
 * the user reads it, and one click hands it to something that can send it. Every
 * part is editable first — the address most of all, because detection ranks
 * candidates and a ranking is a guess.
 *
 * Nothing here sends. The three actions open the default mail client, open a
 * Gmail compose tab, and copy to the clipboard; all three end with a compose
 * window the user still has to press send in. That is not a limitation to
 * apologise for, it is the same promise as "never auto-submits" (§6.7).
 *
 * None of the three can attach a file — `mailto:` forbids it by design — so the
 * panel names the file to attach and offers it as a download rather than
 * pretending the CV went with it.
 */
function EmailApply({
  detection,
  onDraftEmail,
  onSendEmail,
  onDownloadDocument,
  onOpenOptions,
}: {
  detection: EmailDetection;
  onDraftEmail: OverlayProps['onDraftEmail'];
  onSendEmail: OverlayProps['onSendEmail'];
  onDownloadDocument: OverlayProps['onDownloadDocument'];
  onOpenOptions: OverlayProps['onOpenOptions'];
}) {
  const [to, setTo] = useState(detection.best.address);
  const [draft, setDraft] = useState<DraftEmailResponse | undefined>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState<SendMethod | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  const compose = async () => {
    setBusy(true);
    setError(undefined);
    // A redraft is a new email: it has not been sent, whatever the last one did.
    // Leaving this set left the panel claiming "✓ Opened in your mail app" over
    // a draft that had never left the page.
    setSent(undefined);
    try {
      const result = await onDraftEmail(to);
      setDraft(result);
      setSubject(result.subject || subject);
      // Never trade something for nothing. When a redraft comes back empty —
      // the model rate-limited, the profile too thin — whatever the user has
      // already written by hand is worth more than the blank that replaced it.
      if (result.body || !body.trim()) setBody(result.body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = async (method: SendMethod) => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const handed = await onSendEmail(method, { to, subject, body }, draft.entryId);
      if (handed) setSent(method);
      else setError('Could not open that. Copy the email instead.');
    } finally {
      setBusy(false);
    }
  };

  const download = async (blobId: string) => {
    const result = await onDownloadDocument(blobId);
    setSaved(result.ok ? result.detail : undefined);
    if (!result.ok) setError(result.detail);
  };

  const addresses = [detection.best, ...detection.alternatives];

  return (
    <div className="email" onClick={(event) => event.stopPropagation()}>
      <div className="email-field">
        <label htmlFor="autofill-email-to">To</label>
        {addresses.length > 1 && (
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {addresses.map((candidate) => (
              <option key={candidate.address} value={candidate.address}>
                {candidate.address}
                {candidate.region === 'footer' ? ' (from the footer)' : ''}
              </option>
            ))}
          </select>
        )}
        <input
          id="autofill-email-to"
          className="answer-input"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="careers@example.com"
        />
      </div>

      {draft === undefined ? (
        <>
          <button className="btn btn-primary" disabled={busy || !to.trim()} onClick={() => void compose()}>
            {busy ? 'Drafting…' : 'Draft email'}
          </button>
          <span className="muted">
            Written from your profile and résumé. Nothing is sent — you read it first.
          </span>
        </>
      ) : (
        <>
          <div className="email-field">
            <label htmlFor="autofill-email-subject">Subject</label>
            <input
              id="autofill-email-subject"
              className="answer-input"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>

          {/* An empty body is the one outcome that looks identical to the
              feature not running. Whatever caused it gets said here, at full
              weight, above the empty box — not in grey under the buttons where
              the first person to hit it did not see it. */}
          {draft.source === 'plain' && !body.trim() && (
            <div className="email-warn">
              <strong>AutoFill could not write the body</strong>
              {/* `||`, not `??` — an empty-string notice is as useless as none,
                  and rendering it produced a heading over a blank line. */}
              <span>{draft.notice || 'AI assistance is off, so this is a subject line only.'}</span>
              <span>The address and subject are ready — write the body yourself, or fix the above and redraft.</span>
              <button className="btn" onClick={onOpenOptions}>
                Open my profile and AI settings
              </button>
            </div>
          )}

          <div className="email-field">
            <label htmlFor="autofill-email-body">Body</label>
            <textarea
              id="autofill-email-body"
              className="draft"
              rows={10}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                draft.source === 'plain' ? 'Nothing was drafted — type your email here.' : undefined
              }
            />
          </div>

          {/* Named, not attached. No send route can carry a file. */}
          <div className="email-attach">
            <span className="email-attach-head">
              {draft.attachments.length > 0
                ? 'Attach these yourself — no mail link can do it for you'
                : 'No documents stored yet'}
            </span>
            {draft.attachments.map((file) => (
              <div key={file.blobId} className="row-actions">
                <button className="btn" onClick={() => void download(file.blobId)}>
                  Download {file.filename}
                </button>
              </div>
            ))}
            {saved && <span className="muted">✓ Saved {saved} — attach it in your mail app.</span>}
          </div>

          <div className="row-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void send('mailto')}>
              Open mail app
            </button>
            <button className="btn" disabled={busy} onClick={() => void send('gmail')}>
              Gmail
            </button>
            <button className="btn" disabled={busy} onClick={() => void send('clipboard')}>
              Copy
            </button>
            <button className="btn" disabled={busy} onClick={() => void compose()}>
              Redraft
            </button>
          </div>

          <span className="muted">
            {sent
              ? sent === 'clipboard'
                ? '✓ Copied. Recorded as sent — paste it into your mail app and send it.'
                : '✓ Opened in your mail app. Recorded as sent; press send there.'
              : draft.source === 'plain'
                ? 'Recorded as drafted either way — it will be in your Applications list.'
                : 'AI draft — edit it before you send it. AutoFill never sends for you.'}
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
