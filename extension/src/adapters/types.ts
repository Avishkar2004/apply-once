import type { CanonicalKey } from '@autofill/core';
import type { ComboboxStrategy } from '@/core/filler/strategies';

/**
 * ATS adapters (ARCHITECTURE.md §5).
 *
 * "Adapters are optional accelerators, not requirements. The generic pipeline
 * works without them; adapters make known sites instant and correct."
 *
 * The corollary matters more than the definition: **never let an adapter be
 * load-bearing** (§11). A stale selector must degrade to the generic cascade,
 * never to a crash and never to a wrong fill.
 */
export interface AtsAdapter {
  name: string;
  /** Does this adapter own the page? Runs content-side — it needs the document. */
  matches(url: URL, doc: Document): boolean;
  /** Tier 0: CSS selector → canonical key. */
  fieldMap?: Record<string, CanonicalKey>;
  /** Custom widget handling for this ATS's comboboxes. */
  comboboxStrategy?: ComboboxStrategy;
  /** Work history / education blocks that can be added repeatedly. */
  repeatingSections?: RepeatingSection[];
  /** Multi-step wizards — used to re-scan on step change. */
  multiStep?: { nextButton: string; stepIndicator: string };
  /** Known oddities, for the maintainer and the debug view. */
  quirks?: string[];
}

export interface RepeatingSection {
  /** The profile array this section repeats over. */
  source: 'work' | 'education' | 'references';
  /** Wrapper that holds all rows. */
  container: string;
  /** The "add another" button. Clicked *n−1* times (§3.3). */
  addButton: string;
  /** One row inside the container. Row order maps to profile array order. */
  rowSelector: string;
}
