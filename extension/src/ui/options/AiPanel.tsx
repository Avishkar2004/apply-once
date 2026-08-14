import { useCallback, useEffect, useState } from "react";
import type { LlmStatus } from "@/shared/messages";
import { sendToBackground } from "@/shared/messaging";
import {
  ANTHROPIC_ORIGIN,
  requestApiHostPermission,
  revokeApiHostPermission,
} from "@/llm/credentials";
import {
  Banner,
  Button,
  CheckboxField,
  Section,
  TextField,
} from "@/ui/components";

/**
 * AI assistance settings (ARCHITECTURE.md §6.3, §6.4).
 *
 * Two disclosures are load-bearing here rather than decorative:
 *
 *  - §6.3: field mapping never sends profile values, but the Answer Generator
 *    does — "that is disclosed explicitly at the point the feature is enabled".
 *    That sentence is on screen next to the toggle, not in a help page.
 *  - §6.4: the key is the user's own and requests go direct to Anthropic. The
 *    host permission is optional and requested from this button, because Chrome
 *    only grants optional permissions from a user gesture.
 */
export function AiPanel() {
  const [status, setStatus] = useState<LlmStatus | undefined>();
  const [apiKey, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | undefined
  >();

  const refresh = useCallback(async () => {
    setStatus(await sendToBackground("llm:status"));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      // Chrome requires a user gesture; this call is inside the click handler.
      const granted = await requestApiHostPermission();
      if (!granted) {
        setMessage({
          tone: "error",
          text: "Without permission to reach api.anthropic.com, AutoFill cannot use AI assistance.",
        });
        return;
      }
      await sendToBackground("llm:set-key", { apiKey });
      await sendToBackground("settings:set", { llmEnabled: true });
      setApiKeyInput("");
      setMessage({
        tone: "success",
        text: "API key saved. AI assistance is on.",
      });
      await refresh();
    } catch (cause) {
      setMessage({
        tone: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await sendToBackground("llm:clear-key");
      await sendToBackground("settings:set", { llmEnabled: false });
      await revokeApiHostPermission();
      setMessage({
        tone: "success",
        text: "API key removed and permission revoked.",
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const embeddingsLabel = {
    ready: "Ready — reworded fields are matched on-device.",
    loading: "Loading the local model…",
    idle: "Starts on the next fill.",
    unavailable:
      "Not installed — run `npm run fetch:model`. Mapping still works without it.",
  }[status?.embeddings ?? "idle"];

  return (
    <div className="space-y-6">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Section
        title="AI assistance"
        description="Optional. AutoFill maps most fields with rules and on-device matching; AI covers the rest and drafts answers to written questions."
      >
        <div className="col-span-full">
          <Banner tone="info">
            <strong className="block">What is sent, and when</strong>
            <span className="mt-1 block">
              Mapping an unfamiliar field sends its{" "}
              <em>label and options only</em> — never your profile data.
              Drafting an answer to a written question does send your profile
              and résumé text, because the draft has to be about you. Requests
              go directly from this browser to Anthropic using your own API key.
            </span>
          </Banner>
        </div>

        {status?.hasKey ? (
          <>
            <div className="col-span-full space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <p>
                ✅ API key stored, encrypted with your passphrase.
                {status.hasHostPermission
                  ? " Host permission granted."
                  : " Host permission missing."}
              </p>
              <p>🧠 On-device matching: {embeddingsLabel}</p>
              <p>💬 Answer bank: {status.answersStored} saved answer(s).</p>
            </div>
            <CheckboxField
              label="Use AI assistance"
              description="Turning this off keeps your key but stops every model call."
              checked={status.enabled}
              onChange={(llmEnabled) => {
                void sendToBackground("settings:set", { llmEnabled }).then(
                  refresh,
                );
              }}
            />
            <div className="col-span-full">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void removeKey()}
              >
                Remove key and revoke permission
              </Button>
            </div>
          </>
        ) : (
          <>
            <TextField
              span
              label="Anthropic API key"
              type="password"
              hint="stored encrypted on this device"
              value={apiKey}
              onChange={setApiKeyInput}
              placeholder="sk-ant-…"
            />
            <div className="col-span-full">
              <Button
                variant="primary"
                disabled={busy || apiKey.length < 20}
                onClick={() => void saveKey()}
              >
                {busy ? "Saving…" : "Save key and grant access"}
              </Button>
              <p className="mt-2 text-xs text-slate-500">
                Clicking this asks Chrome for permission to reach{" "}
                {ANTHROPIC_ORIGIN}. Nothing is sent until you fill a form that
                needs it.
              </p>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
