import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntryDto } from '@/shared/messages';

/**
 * The applications you have filled, as a vertical deck.
 *
 * Bounded height and scroll-snap, rather than a plain list: the panel keeps a
 * predictable size however long the history grows, and a scroll always settles
 * on a card boundary instead of halfway through one. Full-width cards mean the
 * role and the employer read straight across, which is what a list was good at
 * and a horizontal deck was not.
 *
 * Each card carries a proportion meter rather than a chart. The three segments
 * are *status*, not a data series: filled, needs-checking, left alone. Status
 * colour is never the only signal — every segment is named in the chips beneath
 * it, which is also what keeps the card readable in greyscale.
 */

/** Roughly three cards. Past this the deck scrolls instead of growing. */
const DECK_HEIGHT = 'max-h-[25rem]';

export function ApplicationsCarousel({ entries }: { entries: AuditEntryDto[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState({ top: true, bottom: true });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    // A 2px tolerance: sub-pixel layout means scrollTop rarely lands exactly on
    // the maximum, and an arrow that never disables reads as broken.
    setReach({
      top: el.scrollTop <= 2,
      bottom: el.scrollTop >= el.scrollHeight - el.clientHeight - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = track.current;
    if (!el) return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, entries.length]);

  const step = (direction: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    // One card plus its gap, so a press always lands on a snap point.
    const card = el.firstElementChild as HTMLElement | null;
    const distance = card ? card.offsetHeight + 12 : el.clientHeight * 0.8;
    el.scrollBy({ top: distance * direction, behavior: 'smooth' });
  };

  const fits = reach.top && reach.bottom;

  return (
    <div className="col-span-full">
      <div className="relative">
        <div
          ref={track}
          onScroll={measure}
          tabIndex={0}
          role="region"
          aria-label="Applications"
          className={`flex snap-y snap-mandatory flex-col gap-3 overflow-y-auto outline-none ${DECK_HEIGHT} [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-indigo-400 [&::-webkit-scrollbar]:hidden`}
        >
          {entries.map((entry) => (
            <ApplicationCard key={entry.id ?? `${entry.url}-${entry.at}`} entry={entry} />
          ))}
        </div>

        {/* Edge fades say "there is more" without occupying a row of their own. */}
        {!reach.top && <EdgeFade edge="top" />}
        {!reach.bottom && <EdgeFade edge="bottom" />}
      </div>

      {/* Nothing to page through when every card already fits. */}
      {!fits && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <StepButton direction="up" disabled={reach.top} onClick={() => step(-1)} />
          <StepButton direction="down" disabled={reach.bottom} onClick={() => step(1)} />
        </div>
      )}
    </div>
  );
}

function EdgeFade({ edge }: { edge: 'top' | 'bottom' }) {
  const position = edge === 'top' ? 'top-0 bg-gradient-to-b' : 'bottom-0 bg-gradient-to-t';
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 h-8 from-white to-transparent dark:from-slate-900 ${position}`}
    />
  );
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'up' | 'down';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'up' ? 'Earlier applications' : 'More applications'}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-slate-400 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d={direction === 'up' ? 'M3 10l5-5 5 5' : 'M3 6l5 5 5-5'}
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function ApplicationCard({ entry }: { entry: AuditEntryDto }) {
  const toCheck = entry.lowConfidence + entry.rejected;
  const total = entry.filled + toCheck + entry.skipped;
  const title = entry.jobTitle ?? entry.company ?? entry.hostname;
  const subtitle = [entry.company, entry.hostname]
    .filter((part): part is string => Boolean(part) && part !== title)
    .join(' · ');

  // Rows written before v4 carry no `kind`; they were all fills (§3.7).
  const isEmail = (entry.kind ?? 'form') === 'email';
  const sent = entry.emailStatus === 'sent';

  return (
    <a
      href={entry.url}
      target="_blank"
      rel="noreferrer"
      title={entry.url}
      className="group flex shrink-0 snap-start flex-col gap-2.5 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500"
    >
      <div className="flex items-start gap-3">
        {isEmail ? (
          <EnvelopeMark sent={sent} />
        ) : (
          <Monogram seed={entry.hostname} label={entry.company ?? entry.hostname} />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">
            {title}
          </p>
          {subtitle && (
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
        </div>

        <div className="shrink-0 text-right text-xs text-slate-400 dark:text-slate-500">
          <div>{relativeTime(entry.at)}</div>
          {(entry.fills ?? 1) > 1 && (
            <div>
              {isEmail ? 'drafted' : 'filled'} {entry.fills}×
            </div>
          )}
        </div>
      </div>

      {/* An email application has no fields, so a fill meter would be a bar of
          nothing. What it has instead is a recipient and a status, and those are
          the two things "did I follow up on this one" actually needs. */}
      {isEmail ? (
        <>
          <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
            → {entry.emailTo}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              tone={sent ? 'good' : 'warning'}
              label={sent ? `Sent ${relativeTime(entry.sentAt ?? entry.at)}` : 'Drafted — not sent'}
            />
            <Chip tone="neutral" label="by email" />
          </div>
        </>
      ) : (
        <>
          <Meter filled={entry.filled} toCheck={toCheck} skipped={entry.skipped} total={total} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="good" label={`${entry.filled} filled`} />
            {toCheck > 0 && <Chip tone="warning" label={`${toCheck} to check`} />}
            {entry.skipped > 0 && <Chip tone="neutral" label={`${entry.skipped} skipped`} />}
          </div>
        </>
      )}
    </a>
  );
}

/**
 * An email application reads as one at a glance.
 *
 * Deliberately not a coloured monogram: the deck is scanned by shape first, and
 * "this one went out as an email" is a different *kind* of row, not another
 * employer. Colour carries the sent/drafted state, and the chip beneath repeats
 * it in words — the card stays readable in greyscale.
 */
function EnvelopeMark({ sent }: { sent: boolean }) {
  const tone = sent
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';

  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${tone}`}
      title={sent ? 'Sent by email' : 'Drafted, not sent'}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2 4.5l6 4 6-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * How the fill went, as one bar.
 *
 * Segments are separated by a 2px surface gap rather than a border, so adjacent
 * fills stay distinct without adding a second colour, and the ends are rounded
 * so the bar reads as a whole rather than as a clipped fragment.
 */
function Meter({
  filled,
  toCheck,
  skipped,
  total,
}: {
  filled: number;
  toCheck: number;
  skipped: number;
  total: number;
}) {
  if (total === 0) {
    return <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800" />;
  }

  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;

  return (
    <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      {filled > 0 && <span className="rounded-full bg-emerald-500" style={{ width: pct(filled) }} />}
      {toCheck > 0 && <span className="rounded-full bg-amber-500" style={{ width: pct(toCheck) }} />}
      {skipped > 0 && (
        <span className="rounded-full bg-slate-300 dark:bg-slate-600" style={{ width: pct(skipped) }} />
      )}
    </div>
  );
}

const CHIP_TONES = {
  good: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
} as const;

function Chip({ tone, label }: { tone: keyof typeof CHIP_TONES; label: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${CHIP_TONES[tone]}`}>
      {label}
    </span>
  );
}

/**
 * A company mark, so a deck of cards is scannable by shape as well as by text.
 *
 * The colour is derived from the hostname, never from the card's position, so
 * one employer looks the same wherever it lands in the deck. The letter inside
 * carries the identity; the colour only makes it findable.
 */
const MONOGRAM_TONES = [
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
] as const;

function Monogram({ seed, label }: { seed: string; label: string }) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const tone = MONOGRAM_TONES[hash % MONOGRAM_TONES.length];

  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold uppercase ${tone}`}
      title={label}
    >
      {label.replace(/^www\./, '').charAt(0)}
    </span>
  );
}

/** Exact timestamps are noise in a deck you scroll through. */
export function relativeTime(iso: string): string {
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
