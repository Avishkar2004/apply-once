import type { CanonicalKey, Profile } from '@autofill/core';
import type { FieldDescriptorDto, FillPlan, FillSession, PageContext } from './types';

/**
 * The one message contract between the content script, the UI surfaces and the
 * service worker.
 *
 * Everything that touches decrypted profile data lives behind this boundary: the
 * DEK is held in service-worker memory only (ARCHITECTURE.md §6.2), so the
 * content script asks for resolved values and never for the key.
 *
 * Chrome's `runtime.sendMessage` serialises as JSON, not structured clone —
 * binary payloads travel base64-encoded.
 */

export interface SessionStatus {
  /** A vault exists — the user has set a passphrase at least once. */
  hasVault: boolean;
  /** The DEK is in memory right now. */
  unlocked: boolean;
  /** A profile record exists (it may still be incomplete). */
  hasProfile: boolean;
}

export interface PlanRequest {
  hostname: string;
  url: string;
  /** Adapter that claimed the page, if any (matched content-side — it needs the DOM). */
  adapter?: string;
  fields: FieldDescriptorDto[];
  /** Tier-0 hits the adapter resolved by CSS selector, keyed by field id. */
  adapterMappings?: Record<string, CanonicalKey>;
  /** Job title / company scraped from the page — Tier 3 context (§3.2). */
  pageContext?: PageContext;
}

export interface DocumentPutRequest {
  slot: 'resume' | 'coverLetter' | 'transcript' | 'portfolio';
  filename: string;
  mimeType: string;
  /** base64 of the file bytes. */
  base64: string;
  /** Extracted text, when the caller has it. */
  parsedText?: string;
}

export interface DocumentGetResponse {
  filename: string;
  mimeType: string;
  base64: string;
}

export interface OverrideRecordDto {
  hostname: string;
  signature: string;
  canonicalKey: CanonicalKey;
  label?: string;
  createdAt: string;
}

export interface AuditEntryDto {
  id?: number;
  hostname: string;
  url: string;
  adapter?: string;
  at: string;
  filled: number;
  lowConfidence: number;
  rejected: number;
  skipped: number;
}

export interface SiteAccuracyDto {
  hostname: string;
  adapter?: string;
  samples: number;
  fillRate: number;
  correctionRate: number;
  needsAttention: boolean;
  lastFillAt: string;
}

export interface DraftAnswerRequest {
  question: string;
  maxLength?: number;
  page: PageContext;
}

export interface DraftAnswerResponse {
  answer: string;
  /** `bank` means an approved answer was reused verbatim — free and instant. */
  source: 'bank' | 'llm';
  truncated: boolean;
}

export interface LlmStatus {
  /** The `llmEnabled` setting. */
  enabled: boolean;
  hasKey: boolean;
  hasHostPermission: boolean;
  /** Tier 2 model state — 'ready' means local embeddings are in play. */
  embeddings: 'idle' | 'loading' | 'ready' | 'unavailable';
  answersStored: number;
}

export interface Settings {
  /** Master switch for the extension's fill button. */
  enabled: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Sites the user has explicitly disabled, by hostname. */
  disabledHosts: string[];
  /** Tier 3 / answer drafting. Off until an API key is configured (§6.3, §6.4). */
  llmEnabled: boolean;
  /** Ask before filling voluntary self-identification fields. */
  fillEeo: boolean;
}

export interface RecoveryCodeDto {
  canonical: string;
  formatted: string;
}

/** kind → { req, res }. Adding a message means adding a line here first. */
export interface MessageMap {
  'session:status': { req: undefined; res: SessionStatus };
  'session:create': { req: { passphrase: string }; res: { recoveryCode: RecoveryCodeDto } };
  'session:unlock': { req: { passphrase: string }; res: SessionStatus };
  'session:unlock-recovery': { req: { code: string }; res: SessionStatus };
  'session:lock': { req: undefined; res: SessionStatus };
  'session:rotate-passphrase': { req: { current: string; next: string }; res: { ok: true } };

  'profile:get': { req: undefined; res: Profile };
  'profile:save': { req: { profile: Profile }; res: { ok: true } };
  /**
   * M6 — résumé → profile bootstrap. Returns a *proposed* profile merged
   * non-destructively over the stored one; the user reviews and saves it.
   */
  'profile:from-resume': {
    req: { resumeText: string };
    res: { profile: Profile; added: { work: number; education: number; skills: number } };
  };

  'documents:put': { req: DocumentPutRequest; res: { blobId: string } };
  'documents:get': { req: { blobId: string }; res: DocumentGetResponse };
  'documents:delete': { req: { blobId: string }; res: { ok: true } };

  'mapping:plan': { req: PlanRequest; res: FillPlan };
  'session:report': { req: { session: FillSession }; res: { ok: true } };

  'override:set': {
    req: { hostname: string; signature: string; canonicalKey: CanonicalKey; label?: string };
    res: { ok: true };
  };
  'override:clear': { req: { hostname: string; signature: string }; res: { ok: true } };
  'override:list': { req: { hostname?: string }; res: OverrideRecordDto[] };

  'audit:list': { req: { limit?: number }; res: AuditEntryDto[] };
  'audit:clear': { req: undefined; res: { ok: true } };
  /** §10 accuracy tracking — per-site fill and correction rates. */
  'audit:accuracy': { req: undefined; res: SiteAccuracyDto[] };

  // ── Answer Generator (§3.6) ──
  'answers:draft': { req: DraftAnswerRequest; res: DraftAnswerResponse };
  'answers:approve': {
    req: { question: string; answer: string; company?: string };
    res: { ok: true };
  };

  // ── AI assistance configuration (§6.4) ──
  'llm:status': { req: undefined; res: LlmStatus };
  'llm:set-key': { req: { apiKey: string; baseUrl?: string }; res: { ok: true } };
  'llm:clear-key': { req: undefined; res: { ok: true } };

  'settings:get': { req: undefined; res: Settings };
  'settings:set': { req: Partial<Settings>; res: Settings };

  /** Content scripts cannot call `runtime.openOptionsPage` themselves. */
  'ui:open-options': { req: undefined; res: { ok: true } };

  /** Service worker → content script: the toolbar button was pressed. */
  'content:fill': { req: undefined; res: { started: boolean } };
  /** Content script → side panel: live fill status. */
  'panel:session': { req: { session: FillSession }; res: { ok: true } };
}

export type MessageKind = keyof MessageMap;

export interface RequestEnvelope<K extends MessageKind = MessageKind> {
  kind: K;
  payload: MessageMap[K]['req'];
}

export type ResponseEnvelope<K extends MessageKind = MessageKind> =
  | { ok: true; data: MessageMap[K]['res'] }
  | { ok: false; error: { name: string; message: string } };
