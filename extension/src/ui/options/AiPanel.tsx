import { useCallback, useEffect, useState } from "react";
import type { LlmStatus, Settings } from "@/shared/messages";
import { sendToBackground } from "@/shared/messaging";
import {
  requestApiHostPermission,
  revokeApiHostPermission,
} from "@/llm/credentials";
import {
  getProvider,
  originForProvider,
  PROVIDERS,
  PROVIDER_IDS,
  LLM_ROLES,
  type LlmRole,
  type ProviderId,
} from "@/llm/providers";
import {
  Banner,
  Button,
  CheckboxField,
  Section,
  SelectField,
  TextField,
} from "@/ui/components";

/**
 * AI assistance settings (ARCHITECTURE.md §6.3, §6.4, §7).
 *
 * Three things are load-bearing here rather than decorative:
 *
 *  - §6.3: field mapping never sends profile values, but the Answer Generator
 *    and the email drafter do — "that is disclosed explicitly at the point the
 *    feature is enabled". That sentence is on screen next to the toggle.
 *  - §6.4: the key is the user's own and requests go direct to the provider. The
 *    host permission is optional and requested from a button, because Chrome
 *    only grants optional permissions from a user gesture.
 *  - §7: the provider is a choice, and the default one is free. A key is stored
 *    *per provider* and is never sent to a vendor that did not issue it, so
 *    switching the dropdown asks for a new key rather than reusing the old one.
 */

const ROLE_LABEL: Record<LlmRole, string> = {
  mapping: "Field mapping",
  drafting: "Written answers and emails",
  parsing: "Résumé parsing",
};

const ROLE_HINT: Record<LlmRole, string> = {
  mapping: "classification — a small model is plenty",
  drafting: "the one that writes in your voice",
  parsing: "reads a PDF into your profile",
};

export function AiPanel() {
  const [status, setStatus] = useState<LlmStatus | undefined>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [apiKey, setApiKeyInput] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | undefined
  >();

  const refresh = useCallback(async () => {
    const [next, current] = await Promise.all([
      sendToBackground("llm:status"),
      sendToBackground("settings:get"),
    ]);
    setStatus(next);
    setSettings(current);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected: ProviderId = status?.provider ?? "openrouter";
  const provider = getProvider(selected);
  const origin = originForProvider(selected, baseUrl);

  // "Configured" means something different per provider. For a key-bearing one
  // it is a key *issued for this vendor* — a key that belongs to another is not
  // a key for this one, and saying so is what stops "I already added my key"
  // from meaning nothing. For Ollama there is no key, so the only thing that has
  // to be arranged is the host permission.
  const keyReady = provider.needsKey
    ? status?.hasKey === true && status.keyProvider === selected
    : status?.hasHostPermission === true;

  const chooseProvider = async (next: ProviderId) => {
    setMessage(undefined);
    setApiKeyInput("");
    setBaseUrl("");
    await sendToBackground("settings:set", { llmProvider: next });
    await refresh();
  };

  // Belt and braces beside `repairSettings`: this page is the only way back to
  // a working configuration, so a settings object from some future or foreign
  // build must not be able to blank it out.
  const models = settings?.llmModels?.[selected] ?? {};

  const setModel = async (role: LlmRole, value: string) => {
    if (!settings) return;
    const llmModels = { ...settings.llmModels, [selected]: { ...models, [role]: value } };
    setSettings({ ...settings, llmModels });
    await sendToBackground("settings:set", { llmModels });
  };

  /** Grant the host permission and turn assistance on. Also the keyless path. */
  const connect = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      // Chrome requires a user gesture; this call is inside the click handler.
      const granted = await requestApiHostPermission(origin);
      if (!granted) {
        setMessage({
          tone: "error",
          text: `Without permission to reach ${origin}, AutoFill cannot use ${provider.label}.`,
        });
        return;
      }
      // A keyless provider still needs storing when a base URL was typed —
      // an Ollama on another machine is a URL and no key at all.
      if (provider.needsKey || baseUrl.trim()) {
        await sendToBackground("llm:set-key", {
          provider: selected,
          apiKey,
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        });
      }
      await sendToBackground("settings:set", { llmEnabled: true });
      setApiKeyInput("");
      setMessage({
        tone: "success",
        text: provider.needsKey
          ? `${provider.label} key saved. AI assistance is on.`
          : `Connected to ${provider.label}. AI assistance is on.`,
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

  const disconnect = async () => {
    setBusy(true);
    try {
      await sendToBackground("llm:clear-key");
      await sendToBackground("settings:set", { llmEnabled: false });
      await revokeApiHostPermission(originForProvider(selected));
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
        title="AI provider"
        description="Which model service AutoFill uses. Requests go straight from this browser to the provider you pick — there is no AutoFill server in between."
      >
        <SelectField
          label="Provider"
          value={selected}
          options={PROVIDER_IDS.map((id) => ({
            value: id,
            label: PROVIDERS[id].label,
          }))}
          onChange={(id) => void chooseProvider(id)}
        />

        <div className="col-span-full text-sm text-slate-600 dark:text-slate-300">
          <p>{provider.note}</p>
          <p className="mt-1 text-xs text-slate-500">
            {provider.needsKey ? (
              <>
                Needs an API key.{" "}
                {provider.keyUrl && (
                  <a
                    className="underline"
                    href={provider.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get one here
                  </a>
                )}
                .
              </>
            ) : (
              <>
                No key needed. Start it with <code>ollama serve</code> and pull a
                model first.
              </>
            )}
          </p>
        </div>

        {/* Models are typed, not chosen from a list: free-tier ids change every
            few weeks, and a dropdown of five would be stale by the time anyone
            read it. Blank means "use this provider's default". */}
        {LLM_ROLES.map((role) => (
          <TextField
            key={role}
            label={ROLE_LABEL[role]}
            hint={ROLE_HINT[role]}
            value={models[role] ?? ""}
            placeholder={provider.models[role]}
            onChange={(value) => void setModel(role, value)}
          />
        ))}
      </Section>

      <Section
        title="AI assistance"
        description="Optional. AutoFill maps most fields with rules and on-device matching; AI covers the rest, drafts answers to written questions, and writes application emails."
      >
        <div className="col-span-full">
          <Banner tone="info">
            <strong className="block">What is sent, and when</strong>
            <span className="mt-1 block">
              Mapping an unfamiliar field sends its{" "}
              <em>label and options only</em> — never your profile data. Drafting
              an answer or an application email does send your profile and résumé
              text, because the draft has to be about you. Requests go directly
              from this browser to {provider.label} using your own key
              {provider.needsKey ? "" : ", and on Ollama they never leave this machine"}.
            </span>
          </Banner>
        </div>

        {keyReady ? (
          <>
            <div className="col-span-full space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <p>
                {provider.needsKey
                  ? "✅ API key stored, encrypted with your passphrase."
                  : `✅ Pointed at ${provider.defaultBaseUrl}.`}
                {status?.hasHostPermission
                  ? " Host permission granted."
                  : " Host permission missing."}
              </p>
              <p>
                🤖 {provider.label} · drafting with{" "}
                <code>{status?.models.drafting}</code>
              </p>
              <p>🧠 On-device matching: {embeddingsLabel}</p>
              <p>💬 Answer bank: {status?.answersStored ?? 0} saved answer(s).</p>
            </div>
            <CheckboxField
              label="Use AI assistance"
              description="Turning this off keeps your key but stops every model call."
              checked={status?.enabled ?? false}
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
                onClick={() => void disconnect()}
              >
                {provider.needsKey
                  ? "Remove key and revoke permission"
                  : "Disconnect and revoke permission"}
              </Button>
            </div>
          </>
        ) : (
          <>
            {status?.hasKey && status.keyProvider !== selected && (
              <div className="col-span-full">
                <Banner tone="warn">
                  The stored key was issued for{" "}
                  {getProvider(status.keyProvider).label}. It is never sent to
                  another vendor — save a {provider.label} key to switch.
                </Banner>
              </div>
            )}

            {provider.needsKey && (
              <TextField
                span
                label={`${provider.label} API key`}
                type="password"
                hint="stored encrypted on this device"
                value={apiKey}
                onChange={setApiKeyInput}
                placeholder="sk-…"
              />
            )}
            <TextField
              span
              label="Base URL"
              hint="optional — a self-hosted proxy or a different host"
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={provider.defaultBaseUrl}
            />
            <div className="col-span-full">
              <Button
                variant="primary"
                disabled={busy || (provider.needsKey && apiKey.trim().length < 8)}
                onClick={() => void connect()}
              >
                {busy
                  ? "Saving…"
                  : provider.needsKey
                    ? "Save key and grant access"
                    : "Connect and grant access"}
              </Button>
              <p className="mt-2 text-xs text-slate-500">
                Clicking this asks Chrome for permission to reach {origin}.
                Nothing is sent until you fill a form that needs it.
              </p>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
