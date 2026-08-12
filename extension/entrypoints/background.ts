import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { createLogger } from '@/shared/logger';
import { registerHandlers, sendToTab } from '@/shared/messaging';
import { planFill } from '@/core/orchestrator';
import { forgetCorrection, recordCorrection } from '@/core/learning';
import { approveAnswer, countAnswers, requestDraft } from '@/core/answers';
import { embeddingsState } from '@/core/mapping/tier2';
import { clearApiKey, hasApiHostPermission, hasApiKey, setApiKey } from '@/llm/credentials';
import { applyResumeExtraction, structureResume } from '@/llm/resume-parse';
import { deleteBlob, getBlobBase64, putBlobBase64 } from '@/storage/blob-store';
import { clearAudit, listAudit, recordFill, siteAccuracy } from '@/storage/audit-log';
import { listOverrides } from '@/storage/overrides';
import { readProfile, writeProfile } from '@/storage/profile-store';
import { getSettings, setSettings } from '@/storage/settings';
import {
  createSession,
  lockSession,
  rotateSessionPassphrase,
  sessionStatus,
  unlockSession,
  unlockSessionWithRecoveryCode,
} from '@/storage/session';

const log = createLogger('background');

/**
 * The service worker — the orchestrator of ARCHITECTURE.md §2.
 *
 * It owns the DEK, the database and the mapping cascade. Nothing else in the
 * extension can read the profile; the content script asks for a plan and gets
 * back only the values for the fields it is about to fill.
 */
export default defineBackground(() => {
  registerHandlers({
    // ── session / vault ──
    'session:status': () => sessionStatus(),
    'session:create': async ({ passphrase }) => ({ recoveryCode: await createSession(passphrase) }),
    'session:unlock': ({ passphrase }) => unlockSession(passphrase),
    'session:unlock-recovery': ({ code }) => unlockSessionWithRecoveryCode(code),
    'session:lock': () => lockSession(),
    'session:rotate-passphrase': async ({ current, next }) => {
      await rotateSessionPassphrase(current, next);
      return { ok: true as const };
    },

    // ── profile ──
    'profile:get': () => readProfile(),
    'profile:save': async ({ profile }) => {
      await writeProfile(profile);
      return { ok: true as const };
    },
    // M6 — proposes, never saves. The options page shows what changed first.
    'profile:from-resume': async ({ resumeText }) => {
      const current = await readProfile();
      const merged = applyResumeExtraction(current, await structureResume(resumeText));
      return {
        profile: merged,
        added: {
          work: merged.work.length - current.work.length,
          education: merged.education.length - current.education.length,
          skills: merged.skills.length - current.skills.length,
        },
      };
    },

    // ── documents ──
    'documents:put': async (request) => {
      const meta = await putBlobBase64(request.base64, request.filename, request.mimeType);
      const profile = await readProfile();
      await writeProfile({
        ...profile,
        documents: {
          ...profile.documents,
          [request.slot]: {
            blobId: meta.blobId,
            filename: meta.filename,
            byteSize: meta.byteSize,
            mimeType: meta.mimeType,
            ...(request.parsedText ? { parsedText: request.parsedText } : {}),
          },
        },
      });
      return { blobId: meta.blobId };
    },
    'documents:get': ({ blobId }) => getBlobBase64(blobId),
    'documents:delete': async ({ blobId }) => {
      await deleteBlob(blobId);
      return { ok: true as const };
    },

    // ── the fill pipeline ──
    'mapping:plan': (request) => planFill(request),
    'session:report': async ({ session }) => {
      await recordFill(session);
      return { ok: true as const };
    },

    // ── learned overrides (§3.5) ──
    'override:set': async (correction) => {
      await recordCorrection(correction);
      return { ok: true as const };
    },
    'override:clear': async ({ hostname, signature }) => {
      await forgetCorrection(hostname, signature);
      return { ok: true as const };
    },
    'override:list': ({ hostname }) => listOverrides(hostname),

    // ── audit log (§6.8) ──
    'audit:list': ({ limit }) => listAudit(limit),
    'audit:accuracy': () => siteAccuracy(),
    'audit:clear': async () => {
      await clearAudit();
      return { ok: true as const };
    },

    // ── Answer Generator (§3.6) ──
    'answers:draft': (request) => requestDraft(request),
    'answers:approve': async (input) => {
      await approveAnswer(input);
      return { ok: true as const };
    },

    // ── AI assistance (§6.4) ──
    'llm:status': async () => ({
      enabled: (await getSettings()).llmEnabled,
      hasKey: await hasApiKey(),
      hasHostPermission: await hasApiHostPermission(),
      embeddings: embeddingsState(),
      answersStored: await countAnswers(),
    }),
    'llm:set-key': async ({ apiKey, baseUrl }) => {
      await setApiKey(apiKey, baseUrl);
      return { ok: true as const };
    },
    'llm:clear-key': async () => {
      await clearApiKey();
      return { ok: true as const };
    },

    // ── settings ──
    'settings:get': () => getSettings(),
    'settings:set': (patch) => setSettings(patch),

    'ui:open-options': async () => {
      await browser.runtime.openOptionsPage();
      return { ok: true as const };
    },
  });

  // The toolbar button asks the page to fill. It never submits anything (§6.7).
  browser.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    void sendToTab(tab.id, 'content:fill').catch((error: unknown) => {
      log.warn('no content script on this tab', error);
    });
  });

  // Chrome-only: opening the side panel from the toolbar icon.
  const sidePanel = (browser as unknown as { sidePanel?: { setPanelBehavior?: (o: object) => Promise<void> } })
    .sidePanel;
  void sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });

  log.info('service worker ready');
});
