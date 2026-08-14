/**
 * Overlay styles.
 *
 * ARCHITECTURE.md §3.5 asks for "a shadow-DOM panel (isolated so page CSS cannot
 * touch it)". These rules are injected into a *closed* shadow root as a plain
 * stylesheet rather than through Tailwind: Tailwind's preflight and `:root`
 * custom properties do not cross a shadow boundary reliably, and the whole point
 * of this panel is that nothing about the host page — or our own build — can
 * change how it renders. The options page and the side panel are ordinary
 * documents and do use Tailwind.
 *
 * `all: initial` on the root, plus explicit values everywhere, means an
 * aggressive host stylesheet cannot reach in. The design tokens live on
 * `.panel` rather than `:host` for the same reason: `all: initial` would wipe
 * them.
 *
 * Nothing inheritable is declared on `:host` either. `mount.tsx` sets
 * `all: initial` *inline* on the host, and an inline declaration outranks any
 * rule here — so a `font-family` on `:host` was silently reset before it could
 * be inherited, and the panel rendered in the browser's default serif. Every
 * such property is declared on `.panel` instead, where it is safe.
 *
 * Position is not declared here at all; `mount.tsx` owns it, because the panel
 * is draggable. See `drag.ts`.
 */

/** Kept in sync with `.panel`'s width — `mount.tsx` needs it before first paint. */
export const PANEL_WIDTH = 372;

export const OVERLAY_CSS = `
:host {
  all: initial;
  display: block;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --bg:        #ffffff;
  --bg-sunken: #f8fafc;
  --bg-hover:  #f1f5f9;
  --fg:        #0f172a;
  --fg-muted:  #64748b;
  --line:      #e2e8f0;
  --line-soft: #f1f5f9;
  --accent:    #4f46e5;
  --ok:        #059669;
  --warn:      #d97706;
  --bad:       #e11d48;
  --idle:      #cbd5e1;

  width: 372px;
  max-height: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 8px 16px rgba(15, 23, 42, 0.08),
    0 24px 48px rgba(15, 23, 42, 0.12);
  overflow: hidden;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  .panel {
    --bg:        #0f172a;
    --bg-sunken: #131f37;
    --bg-hover:  #1e293b;
    --fg:        #f1f5f9;
    --fg-muted:  #94a3b8;
    --line:      #29374d;
    --line-soft: #1e293b;
    --accent:    #818cf8;
    --ok:        #34d399;
    --warn:      #fbbf24;
    --bad:       #fb7185;
    --idle:      #475569;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
  }
}

/* ── header ─────────────────────────────────────────────── */

/* The whole header is the grab handle — a bigger target than a title bar, and
   it holds nothing clickable except the close button, which opts out. */
.head {
  padding: 12px 14px 0;
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
:host([data-dragging]) .head { cursor: grabbing; }
:host([data-dragging]) .panel {
  box-shadow: 0 2px 4px rgba(15, 23, 42, 0.06), 0 32px 64px rgba(15, 23, 42, 0.22);
}

.brand { display: flex; align-items: center; gap: 8px; }

/* Dotted grip — without it nobody discovers the panel can be moved. */
.grip {
  width: 9px;
  height: 15px;
  flex-shrink: 0;
  opacity: 0.35;
  background-image: radial-gradient(currentColor 1.05px, transparent 1.15px);
  background-size: 4px 4px;
  background-position: 0 2px;
}
.brand-mark {
  width: 18px; height: 18px;
  border-radius: 5px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.brand-name { font-size: 13px; font-weight: 650; letter-spacing: -0.01em; }
.brand-host {
  flex: 1;
  min-width: 0;
  text-align: right;
  color: var(--fg-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
}

/* Proportion of the form each status accounts for — the whole result in one
   glance, before any reading. */
.meter {
  display: flex;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--line-soft);
  gap: 1px;
}
.meter > span { display: block; transition: width 200ms ease; }
.meter-ok   { background: var(--ok); }
.meter-warn { background: var(--warn); }
.meter-bad  { background: var(--bad); }
.meter-idle { background: var(--idle); }

.stats { display: flex; gap: 18px; padding-bottom: 12px; }
.stat { display: flex; flex-direction: column; gap: 1px; }
.stat-n {
  font-size: 17px;
  font-weight: 650;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.stat-l {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.stat-ok   .stat-n { color: var(--ok); }
.stat-warn .stat-n { color: var(--warn); }
.stat-bad  .stat-n { color: var(--bad); }
.stat-idle .stat-n { color: var(--fg-muted); }

/* ── body ───────────────────────────────────────────────── */

.body { overflow-y: auto; flex: 1; overscroll-behavior: contain; }
.body::-webkit-scrollbar { width: 10px; }
.body::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 999px;
  border: 3px solid var(--bg);
}

.section-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 14px;
  background: var(--bg);
  border-bottom: 1px solid var(--line-soft);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.section-n {
  font-variant-numeric: tabular-nums;
  background: var(--bg-hover);
  color: var(--fg-muted);
  border-radius: 999px;
  padding: 1px 7px;
  letter-spacing: 0;
  font-size: 10px;
}

/* Collapsed groups use native <details> — keyboard accessible, no state. */
.fold > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary:hover { background: var(--bg-hover); }
.fold > summary .chev { transition: transform 140ms ease; display: inline-block; }
.fold[open] > summary .chev { transform: rotate(90deg); }
.summary-label { display: flex; align-items: center; gap: 6px; }

/* ── rows ───────────────────────────────────────────────── */

.row {
  position: relative;
  padding: 10px 14px 10px 18px;
  border-bottom: 1px solid var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}
.row::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 999px;
  background: var(--idle);
}
.row-filled::before          { background: var(--ok); }
.row-low-confidence::before  { background: var(--warn); }
.row-rejected::before        { background: var(--bad); }
.row:hover { background: var(--bg-hover); }
.row:last-child { border-bottom: none; }

.row-head { display: flex; align-items: flex-start; gap: 8px; }
.row-label {
  font-weight: 550;
  flex: 1;
  min-width: 0;
  word-break: break-word;
  font-size: 12.5px;
}
.row-actions { display: flex; gap: 6px; flex-shrink: 0; }

.value {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
  background: var(--bg-sunken);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 4px 7px;
  word-break: break-word;
  color: var(--fg);
}

/* Compact single-line form for the collapsed "filled" list. */
.row-compact { padding-top: 7px; padding-bottom: 7px; gap: 3px; }
.row-compact .value {
  background: none;
  border: none;
  padding: 0;
  color: var(--fg-muted);
  font-size: 11px;
}

.muted { color: var(--fg-muted); font-size: 11.5px; }
.tail { padding: 9px 14px; color: var(--fg-muted); font-size: 11.5px; }

/* ── controls ───────────────────────────────────────────── */

.btn {
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--fg);
  border-radius: 7px;
  padding: 4px 9px;
  font-size: 11.5px;
  font-weight: 550;
  cursor: pointer;
  font-family: inherit;
  transition: background 120ms ease, border-color 120ms ease;
}
.btn:hover { background: var(--bg-hover); border-color: var(--fg-muted); }
.btn[disabled] { opacity: 0.45; cursor: default; }
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
.btn-primary:hover { filter: brightness(1.08); border-color: var(--accent); }
.btn-ghost { border-color: transparent; background: transparent; padding: 2px 6px; }

.answer { display: flex; flex-direction: column; gap: 5px; }
.answer .row-actions { flex-wrap: wrap; }
.answer-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
  background: var(--bg);
  color: var(--fg);
}
.answer-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

.draft {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 7px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.5;
  background: var(--bg);
  color: var(--fg);
  resize: vertical;
  margin-bottom: 6px;
}

select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 7px;
  font-size: 11.5px;
  background: var(--bg);
  color: var(--fg);
  font-family: inherit;
  cursor: pointer;
}
select:hover { border-color: var(--fg-muted); }

/* ── footer + notices ───────────────────────────────────── */

.foot {
  padding: 9px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}
.pledge { display: flex; align-items: center; gap: 5px; color: var(--fg-muted); }

.notice { padding: 16px 14px; display: flex; flex-direction: column; gap: 9px; align-items: flex-start; }
.notice strong { font-size: 13px; font-weight: 650; }

.progress { height: 4px; background: var(--line-soft); border-radius: 999px; overflow: hidden; width: 100%; }
.progress > span { display: block; height: 100%; background: var(--accent); transition: width 120ms linear; }

.icon-close {
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 5px;
}
.icon-close:hover { color: var(--fg); background: var(--bg-hover); }
`;
