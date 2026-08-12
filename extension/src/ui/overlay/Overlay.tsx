import { useMemo, useState } from 'react';
import type { CanonicalKey } from '@autofill/core';
import type { FillOutcome, FillSession } from '@/shared/types';
import { KeyPicker } from './KeyPicker';

/**
 * The review overlay (ARCHITECTURE.md §3.5).
 *
 * It shows what needs attention, not what worked: ⚠️ low-confidence, ❌ rejected
 * and ⬜ skipped rows. The ✅ count is in the header, because a list of 31
 * correct fields is noise.
 *
 * "Never auto-submits" is in the footer on every render — it is the product's
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
}

const ICONS = {
  filled: '✅',
  'low-confidence': '⚠️',
  rejected: '❌',
  skipped: '⬜',
} as const;

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
  const title = session ? `${session.hostname}${session.adapter ? ` · ${session.adapter}` : ''}` : 'AutoFill';

  return (
    <div className="head">
      <div className="title">
        <strong>AutoFill — {title}</strong>
        <button className="icon-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {session && (
        <div className="counts">
          <span className="count">✅ {session.summary.filled} filled</span>
          <span className="count">⚠️ {session.summary.lowConfidence} check</span>
          {session.summary.rejected > 0 && <span className="count">❌ {session.summary.rejected} failed</span>}
          <span className="count">⬜ {session.summary.skipped} skip</span>
        </div>
      )}
    </div>
  );
}

function FillingBody({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="notice">
      <span>Filling {total} fields…</span>
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

function ResultBody({
  session,
  unreachableFrames,
  onHighlight,
  onCorrect,
  onDraft,
  onAcceptDraft,
}: { session: FillSession } & OverlayProps) {
  const needsAttention = useMemo(
    () => session.outcomes.filter((outcome) => outcome.status !== 'filled'),
    [session],
  );

  if (needsAttention.length === 0) {
    return (
      <div className="notice">
        <strong>Everything mapped cleanly.</strong>
        <span className="muted">
          {session.summary.filled} fields filled in {(session.summary.durationMs / 1000).toFixed(1)}s. Review
          them before you submit.
        </span>
        {unreachableFrames > 0 && <FrameCaveat count={unreachableFrames} />}
      </div>
    );
  }

  return (
    <div className="body">
      {needsAttention.map((outcome) => (
        <Row
          key={outcome.fieldId}
          outcome={outcome}
          onHighlight={onHighlight}
          onCorrect={onCorrect}
          onDraft={onDraft}
          onAcceptDraft={onAcceptDraft}
        />
      ))}
      {unreachableFrames > 0 && (
        <div className="row">
          <FrameCaveat count={unreachableFrames} />
        </div>
      )}
    </div>
  );
}

function FrameCaveat({ count }: { count: number }) {
  return (
    <span className="muted">
      {count} embedded {count === 1 ? 'frame' : 'frames'} could not be read — anything inside{' '}
      {count === 1 ? 'it' : 'them'} needs filling by hand.
    </span>
  );
}

function Row({
  outcome,
  onHighlight,
  onCorrect,
  onDraft,
  onAcceptDraft,
}: {
  outcome: FillOutcome;
  onHighlight: (fieldId: string) => void;
  onCorrect: (outcome: FillOutcome, key: CanonicalKey) => Promise<void>;
  onDraft: OverlayProps['onDraft'];
  onAcceptDraft: OverlayProps['onAcceptDraft'];
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
  // instead of the canonical-key picker (§3.6).
  const isFreeText = outcome.skipReason === 'free-text';

  return (
    <div className="row" onClick={() => onHighlight(outcome.fieldId)}>
      <div className="row-head">
        <span aria-hidden>{ICONS[outcome.status]}</span>
        <span className="row-label">{outcome.label}</span>
        {outcome.status !== 'skipped' && !accepted && (
          <span className="row-actions">
            <button
              className="btn"
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

      {outcome.actual ? <div className="value">→ {outcome.actual}</div> : null}
      {outcome.reason && <span className="muted">{outcome.reason}</span>}

      {isFreeText ? (
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

  if (used) return <span className="muted">✅ Answer written. Review it before you submit.</span>;

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

function Footer({ phase, onRefill }: OverlayProps) {
  return (
    <div className="foot">
      <span className="muted">Never auto-submits. Review &amp; submit.</span>
      <button className="btn" onClick={onRefill} disabled={phase.kind === 'filling'}>
        Re-fill
      </button>
    </div>
  );
}
