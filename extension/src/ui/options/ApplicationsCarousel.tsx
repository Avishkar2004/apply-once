import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntryDto } from '@/shared/messages';

/**
 * The applications you have filled, as a horizontal deck.
 *
 * A carousel trades scanning for presence: three cards are visible where a list
 * showed ten rows, so finding a specific application takes longer. Scroll-snap
 * is what makes that trade acceptable — a flick moves a whole card, and the
 * arrows step one at a time, so nothing depends on a precise drag.
 *
 * Each card carries a proportion meter rather than a chart. The three segments
 * are *status*, not a data series: filled, needs-checking, left alone. Status
 * colour is never the only signal — every segment is named in the row of chips
 * beneath it, which is also what makes the card readable in greyscale.
 */

export function ApplicationsCarousel({ entries }: { entries: AuditEntryDto[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    // A 2px tolerance: sub-pixel layout means scrollLeft rarely lands exactly on
    // the maximum, and an arrow that never disables reads as broken.
    setReach({
      start: el.scrollLeft <= 2,
      end: el.scrollLeft >= el.scrollWidth - el.clientWidth - 2,
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
    const distance = card ? card.offsetWidth + 16 : el.clientWidth * 0.8;
    el.scrollBy({ left: distance * direction, behavior: 'smooth' });
  };

  const atBothEnds = reach.start && reach.end;

  return (
    <div className="sm:col-span-2">
      <div
        ref={track}
        onScroll={measure}
        tabIndex={0}
        role="region"
        aria-label="Applications"
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-indigo-400 [&::-webkit-scrollbar]:hidden"
      >
        {entries.map((entry) => (
          <ApplicationCard key={entry.id ?? `${entry.url}-${entry.at}`} entry={entry} />
        ))}
      </div>

      {/* Nothing to page through when every card already fits. */}
      {!atBothEnds && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <StepButton direction="left" disabled={reach.start} onClick={() => step(-1)} />
          <StepButton direction="right" disabled={reach.end} onClick={() => step(1)} />
        </div>
      )}
    </div>
  );
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'left' | 'right';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'left' ? 'Previous applications' : 'More applications'}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-slate-400 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d={direction === 'left' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'}
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

  return (
    <a
      href={entry.url}
      target="_blank"
      rel="noreferrer"
      title={entry.url}
      className="group flex w-72 shrink-0 snap-start flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500"
    >
      <div className="flex items-center gap-2.5">
        <Monogram seed={entry.hostname} label={entry.company ?? entry.hostname} />
        <span className="truncate text-xs text-slate-400 dark:text-slate-500">
          {relativeTime(entry.at)}
          {(entry.fills ?? 1) > 1 && ` · filled ${entry.fills}×`}
        </span>
      </div>

      <div className="min-h-[3.25rem]">
        <p className="line-clamp-2 text-sm font-semibold text-slate-900 group-hover:text-indigo-600 dark:text-slate-100 dark:group-hover:text-indigo-400">
          {title}
        </p>
        {subtitle && (
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        )}
      </div>

      <Meter filled={entry.filled} toCheck={toCheck} skipped={entry.skipped} total={total} />

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="good" label={`${entry.filled} filled`} />
        {toCheck > 0 && <Chip tone="warning" label={`${toCheck} to check`} />}
        {entry.skipped > 0 && <Chip tone="neutral" label={`${entry.skipped} skipped`} />}
      </div>
    </a>
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
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold uppercase ${tone}`}
      title={label}
    >
      {label.replace(/^www\./, '').charAt(0)}
    </span>
  );
}

/** Exact timestamps are noise in a deck you flick through. */
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
