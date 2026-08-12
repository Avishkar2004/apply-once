import type { FieldDescriptor } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { safeClick } from '@/core/filler/guards';
import { sleep, WIDGET_TIMEOUT_MS } from '@/core/filler/pacing';
import type { AtsAdapter, RepeatingSection } from './types';

const log = createLogger('adapters/repeating');

/**
 * Repeating sections — work history, education (ARCHITECTURE.md §3.3).
 *
 * "Adapters declare an 'add another' button selector. The executor clicks it
 * *n−1* times, waits for the new row to mount, re-scans, then fills row by row.
 * Rows are matched by DOM order against the profile array."
 *
 * `safeClick` still applies to the add button — an "add another" that is
 * secretly a submit control would be blocked, which is the correct outcome.
 */

const ROW_MOUNT_POLL_MS = 100;

/** Click "add another" until the section has `wanted` rows, or the button gives up. */
export async function expandSection(
  section: RepeatingSection,
  wanted: number,
  doc: Document = document,
): Promise<number> {
  const container = doc.querySelector(section.container);
  if (!container) return 0;

  const rowCount = () => container.querySelectorAll(section.rowSelector).length;
  let current = rowCount();

  while (current < wanted) {
    const button = doc.querySelector(section.addButton);
    if (!(button instanceof HTMLElement)) break;

    safeClick(button);
    const grew = await waitForRowCount(container, section.rowSelector, current + 1);
    if (!grew) {
      log.warn(`"${section.addButton}" did not add a row; stopping at ${current}`);
      break;
    }
    current = rowCount();
  }

  return current;
}

async function waitForRowCount(
  container: Element,
  rowSelector: string,
  target: number,
): Promise<boolean> {
  const deadline = Date.now() + WIDGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (container.querySelectorAll(rowSelector).length >= target) return true;
    await sleep(ROW_MOUNT_POLL_MS);
  }
  return false;
}

/**
 * Tag each field with the repeating row it sits in, so `resolveValue` reads
 * `work[2].company` rather than always `work[0].company`.
 *
 * Mutates in place and returns the same array — the descriptors are already the
 * live objects the filler will use.
 */
export function annotateRepeatingRows(
  adapter: AtsAdapter | undefined,
  fields: FieldDescriptor[],
  doc: Document = document,
): FieldDescriptor[] {
  if (!adapter?.repeatingSections?.length) return fields;

  for (const section of adapter.repeatingSections) {
    const container = doc.querySelector(section.container);
    if (!container) continue;

    const rows = [...container.querySelectorAll(section.rowSelector)];
    if (rows.length === 0) continue;

    for (const field of fields) {
      const el = field.el.deref();
      if (!el) continue;
      const rowIndex = rows.findIndex((row) => row.contains(el));
      if (rowIndex >= 0) {
        field.rowIndex = rowIndex;
        field.repeatingSection = section.source;
      }
    }
  }

  return fields;
}
