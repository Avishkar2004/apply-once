import type { CanonicalKey, MappingTarget, ResolvedValue } from '@autofill/core';

/**
 * The types every stage of the pipeline agrees on:
 * scanner → mapping → filler → verifier → overlay.
 */

/** ARCHITECTURE.md §3.1. */
export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'date'
  | 'number'
  | 'textarea'
  | 'select'
  | 'radio-group'
  | 'checkbox'
  | 'file'
  | 'combobox';

export interface FieldOption {
  value: string;
  text: string;
}

export type FrameworkHint = 'react' | 'vue' | 'angular' | 'plain';

/**
 * The serialisable half of a `FieldDescriptor` — exactly what crosses the
 * content-script → service-worker boundary. It carries labels and options and
 * never a profile value (ARCHITECTURE.md §6.3).
 */
export interface FieldDescriptorDto {
  /** Stable hash of the field. */
  id: string;
  kind: FieldKind;
  /** Normalised concatenation of every label signal — what the matcher sees. */
  labelBlob: string;
  /** The single best human-readable label — what the review overlay shows. */
  displayLabel: string;
  /** The browser autocomplete attribute, if the site set an honest one. */
  autocomplete?: string;
  name?: string;
  required: boolean;
  maxLength?: number;
  options?: FieldOption[];
  /** Nearest `<h*>` or `<legend>` above — disambiguates "Name" and "Date". */
  sectionHeading?: string;
  frameworkHint?: FrameworkHint;
  /**
   * hash(tagName + type + name + labelBlob) — the cache key. Stable across page
   * loads and independent of DOM position (ARCHITECTURE.md §3.1).
   */
  signature: string;

  // — extra scan signals the filler needs; still label-level, never PII —
  /** Raw `type` attribute for inputs, used for date-format sniffing. */
  inputType?: string;
  placeholder?: string;
  pattern?: string;
  /** Index of this field's repeating-section row, when it is inside one. */
  rowIndex?: number;
  /** Name of the repeating section this field belongs to, if any. */
  repeatingSection?: string;
}

/** The live, DOM-bound descriptor. Never crosses a message boundary. */
export interface FieldDescriptor extends FieldDescriptorDto {
  el: WeakRef<Element>;
  /** Every input of a radio group, in DOM order. */
  radios?: Array<WeakRef<HTMLInputElement>>;
  /** The widget wrapper — where a combobox's listbox is expected to appear. */
  container?: WeakRef<Element>;
}

export const toDto = (field: FieldDescriptor): FieldDescriptorDto => {
  const { el: _el, radios: _radios, container: _container, ...dto } = field;
  return dto;
};

/**
 * What this page is an application *for* — the job title and company Tier 3
 * uses as disambiguating context (§3.2), plus the job description the Answer
 * Generator grounds drafts in (§3.6). Scraped from the page, never from the
 * profile, so it is safe to send with a mapping request.
 */
export interface PageContext {
  jobTitle?: string;
  company?: string;
  jobDescription?: string;
}

/** Which tier of the cascade produced a mapping (ARCHITECTURE.md §3.2). */
export type MappingSource = 'override' | 'adapter' | 'rule' | 'embedding' | 'llm';

export interface FieldMapping {
  fieldId: string;
  target: MappingTarget;
  confidence: number;
  source: MappingSource;
}

export type SkipReason =
  | 'unmapped'
  | 'no-profile-data'
  | 'free-text'
  | 'not-fillable'
  | 'eeo-disabled'
  | 'cross-origin-frame';

export interface FillInstruction {
  fieldId: string;
  key: CanonicalKey;
  value: ResolvedValue;
  confidence: number;
  source: MappingSource;
}

export interface SkippedField {
  fieldId: string;
  reason: SkipReason;
  /** Present when the field mapped but the profile had nothing for it. */
  key?: CanonicalKey;
}

export interface FillPlan {
  instructions: FillInstruction[];
  skipped: SkippedField[];
}

/** ARCHITECTURE.md §3.4. */
export type FillStatus = 'filled' | 'low-confidence' | 'rejected' | 'skipped';

export interface FillOutcome {
  fieldId: string;
  status: FillStatus;
  /** Human-readable label for the overlay row. */
  label: string;
  key?: CanonicalKey;
  /** What we tried to write. */
  intended?: string;
  /** What the DOM actually holds afterwards. */
  actual?: string;
  confidence?: number;
  source?: MappingSource;
  /** Why it was skipped or rejected, in prose, for the overlay. */
  reason?: string;
  /** The machine-readable form — the UI branches on this, never on `reason`. */
  skipReason?: SkipReason;
  signature: string;
}

export interface FillSummary {
  filled: number;
  lowConfidence: number;
  rejected: number;
  skipped: number;
  total: number;
  durationMs: number;
}

export interface FillSession {
  sessionId: string;
  hostname: string;
  url: string;
  adapter?: string;
  outcomes: FillOutcome[];
  summary: FillSummary;
  startedAt: string;
}

/**
 * Confidence thresholds (ARCHITECTURE.md §3.2).
 * A field is shown amber in the overlay when it lands below `reviewThreshold`.
 */
export const CONFIDENCE = {
  override: 1.0,
  adapter: 1.0,
  rule: 0.95,
  /** Tier 2 accepts at or above this. */
  embeddingAccept: 0.82,
  /** Below this, Tier 2 gives up and the field falls through to Tier 3. */
  embeddingFloor: 0.6,
  /** Anything below this is filled but flagged for review. */
  reviewThreshold: 0.82,
} as const;
