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
 * aggressive host stylesheet cannot reach in.
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
  width: 360px;
  max-height: min(70vh, 620px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #111827;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  overflow: hidden;
  font-size: 13px;
  line-height: 1.45;
}

@media (prefers-color-scheme: dark) {
  .panel { background: #111827; color: #f9fafb; border-color: #374151; }
  .head, .foot { background: #0b1220; border-color: #374151; }
  .row { border-color: #1f2937; }
  .row:hover { background: #1f2937; }
  select, .btn, .draft { background: #1f2937; color: #f9fafb; border-color: #374151; }
  .muted { color: #9ca3af; }
  .value { background: #0b1220; }
}

.head {
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title strong { font-size: 13px; font-weight: 600; }
.counts { display: flex; gap: 10px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.count { display: inline-flex; align-items: center; gap: 4px; }

.body { overflow-y: auto; flex: 1; }

.row {
  padding: 10px 12px;
  border-bottom: 1px solid #f3f4f6;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}
.row:hover { background: #f9fafb; }
.row-head { display: flex; align-items: flex-start; gap: 8px; }
.row-label { font-weight: 500; flex: 1; word-break: break-word; }
.row-actions { display: flex; gap: 6px; flex-shrink: 0; }

.value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 4px 6px;
  word-break: break-word;
}

.muted { color: #6b7280; font-size: 12px; }

.btn {
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: inherit;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.btn:hover { border-color: #9ca3af; }
.btn[disabled] { opacity: 0.5; cursor: default; }
.btn-primary { background: #4f46e5; border-color: #4f46e5; color: #ffffff; }
.btn-primary:hover { background: #4338ca; }

.draft {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.45;
  background: #ffffff;
  color: inherit;
  resize: vertical;
  margin-bottom: 6px;
}

select {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 12px;
  background: #ffffff;
  color: inherit;
  font-family: inherit;
}

.foot {
  padding: 8px 12px;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.notice { padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.progress { height: 3px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }
.progress > span { display: block; height: 100%; background: #4f46e5; transition: width 120ms linear; }

.icon-close {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
`;
