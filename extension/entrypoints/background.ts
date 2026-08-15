import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { createLogger } from '@/shared/logger';
import { registerHandlers, sendToTab } from '@/shared/messaging';
import { planFill } from '@/core/orchestrator';
import { forgetCorrection, recordCorrection } from '@/core/learning';
import { approveAnswer, countAnswers, requestDraft } from '@/core/answers';
import { confirmEmailSent, requestEmailDraft } from '@/core/email/apply';
import { embeddingsState } from '@/core/mapping/tier2';
import {
  clearApiKey,
  hasApiHostPermission,
  hasApiKey,
  setApiKey,
  storedKeyProvider,
} from '@/llm/credentials';
import { getProvider, originForProvider, resolveModel } from '@/llm/providers';
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
/** The built content script, as it lands in the extension package. */
const CONTENT_SCRIPT = '/content-scripts/content.js';

/** Pages no extension may script. Worth naming so the failure is explicable. */
const UNSCRIPTABLE =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https:\/\/chromewebstore\.google\.com/;

/**
 * Open the profile editor as a real tab.
 *
 * Deliberately not `runtime.openOptionsPage()`: that helper honours
 * `options_ui.open_in_tab`, and when it is false Chrome renders the page as an
 * overlay *inside* `chrome://extensions` — which reads as "the button sent me to
 * the extensions page". Opening the URL directly always behaves the same way.
 */
async function openProfileEditor(): Promise<void> {
  const url = browser.runtime.getURL('/options.html');

  const [existing] = await browser.tabs.query({ url });
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await browser.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await browser.tabs.create({ url });
}

/**
 * Fill whatever tab the user is looking at.
 *
 * Message first, inject second: where the declared content script is already
 * running, injecting again would put a second copy in the same frame.
 */
async function fillActiveTab(tab: {
  id?: number | undefined;
  url?: string | undefined;
}): Promise<void> {
  if (typeof tab.id !== 'number') return;

  if (tab.url && UNSCRIPTABLE.test(tab.url)) {
    log.info('browsers do not allow extensions to script this page');
    await flashBadge('—', '#6b7280');
    return;
  }

  try {
    await sendToTab(tab.id, 'content:fill');
    return;
  } catch {
    log.debug('no content script in this tab yet — injecting');
  }

  await browser.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: [CONTENT_SCRIPT],
  });

  // The injected script registers its listener during evaluation, so it is
  // ready by the time `executeScript` resolves.
  await sendToTab(tab.id, 'content:fill');
}

/** Brief toolbar feedback for the cases that never reach the page. */
async function flashBadge(text: string, colour: string): Promise<void> {
  await browser.action.setBadgeText({ text });
  await browser.action.setBadgeBackgroundColor({ color: colour });
  setTimeout(() => void browser.action.setBadgeText({ text: '' }), 4000);
}

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

    // ── Email Apply (§3.7) ──
    // `email:detect` is handled in the content script — it needs the DOM.
    'email:draft': (request) => requestEmailDraft(request),
    'email:mark-sent': async ({ entryId, to }) => {
      await confirmEmailSent(entryId, to);
      return { ok: true as const };
    },

    // ── AI assistance (§6.4, §7) ──
    'llm:status': async () => {
      const settings = await getSettings();
      const provider = getProvider(settings.llmProvider);
      const keyProvider = await storedKeyProvider();
      return {
        enabled: settings.llmEnabled,
        hasKey: await hasApiKey(),
        // The origin actually called, not the vendor's — a self-hosted proxy
        // needs its own grant (see `originForProvider`).
        hasHostPermission: await hasApiHostPermission(originForProvider(provider.id)),
        provider: provider.id,
        ...(keyProvider ? { keyProvider } : {}),
        models: {
          mapping: resolveModel(provider, 'mapping', settings.llmModels),
          drafting: resolveModel(provider, 'drafting', settings.llmModels),
          parsing: resolveModel(provider, 'parsing', settings.llmModels),
        },
        embeddings: embeddingsState(),
        answersStored: await countAnswers(),
      };
    },
    'llm:set-key': async ({ provider, apiKey, baseUrl }) => {
      await setApiKey(provider, apiKey, baseUrl);
      return { ok: true as const };
    },
    'llm:clear-key': async () => {
      await clearApiKey();
      return { ok: true as const };
    },

    // ── settings ──
    'settings:get': () => getSettings(),
    'settings:set': (patch) => setSettings(patch),

    // Deliberately not `openOptionsPage()` — see `openProfileEditor`. The panel
    // and the toolbar button must land in the same place, every time.
    'ui:open-options': async () => {
      await openProfileEditor();
      return { ok: true as const };
    },
  });

  // The toolbar button asks the page to fill. It never submits anything (§6.7).
  // First run: open the profile editor. Nothing else tells a new user where to
  // go, and an extension whose button appears to do nothing reads as broken.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') void openProfileEditor();
  });

  /**
   * The toolbar button fills the page you are on. It never submits (§6.7), and
   * it never navigates you away.
   *
   * Works on any site. The content script is declared for all URLs, but a page
   * loaded before this extension was installed or reloaded has no script in it
   * — so if the message finds no listener, inject one and retry rather than
   * failing silently, which is what made this look broken.
   */
  browser.action.onClicked.addListener((tab) => {
    void fillActiveTab(tab).catch((error: unknown) => {
      log.error('could not fill this tab', error);
      void flashBadge('!', '#dc2626');
    });
  });

  // Chrome-only: opening the side panel from the toolbar icon.
  const sidePanel = (browser as unknown as { sidePanel?: { setPanelBehavior?: (o: object) => Promise<void> } })
    .sidePanel;
  void sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });

  log.info('service worker ready');
});
