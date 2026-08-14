import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS } from "@/storage/settings";
import type { Settings } from "@/shared/messages";
import { sendToBackground } from "@/shared/messaging";
import {
  Banner,
  Button,
  CheckboxField,
  Section,
  TextField,
} from "@/ui/components";

/**
 * Settings and vault management.
 *
 * Everything here is a non-sensitive preference and lives in
 * `chrome.storage.sync` (ARCHITECTURE.md §4) — except the passphrase change,
 * which re-wraps the DEK locally and touches no stored data (WEB.md §3.1).
 */
export function SettingsPanel({ onLocked }: { onLocked: () => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | undefined
  >();

  useEffect(() => {
    void sendToBackground("settings:get").then(setSettings);
  }, []);

  const patch = async (next: Partial<Settings>) => {
    setSettings(await sendToBackground("settings:set", next));
  };

  return (
    <div className="space-y-6">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Section title="Filling">
        <CheckboxField
          label="Enable AutoFill"
          description="Turn the whole extension off without uninstalling it."
          checked={settings.enabled}
          onChange={(enabled) => void patch({ enabled })}
        />
        <CheckboxField
          label="Fill automatically when I open an application"
          description="Fills as soon as a form is detected, without waiting for a click. AutoFill still never submits — you always review first."
          checked={settings.autoFill}
          onChange={(autoFill) => void patch({ autoFill })}
        />
        <CheckboxField
          label="Fill voluntary self-identification questions"
          description="Off by default. When off, EEO questions are recognised but left blank for you to answer yourself."
          checked={settings.fillEeo}
          onChange={(fillEeo) => void patch({ fillEeo })}
        />
        <TextField
          span
          label="Disabled sites"
          hint="hostnames, comma separated"
          value={settings.disabledHosts.join(", ")}
          onChange={(value) =>
            void patch({
              disabledHosts: value
                .split(",")
                .map((host) => host.trim())
                .filter(Boolean),
            })
          }
        />
      </Section>

      <PassphraseSection onMessage={setMessage} />

      <Section
        title="Session"
        description="The unlock key lives in memory and is cleared when the browser closes."
      >
        <div className="col-span-full">
          <Button
            onClick={() => {
              void sendToBackground("session:lock").then(onLocked);
            }}
          >
            Lock now
          </Button>
        </div>
      </Section>
    </div>
  );
}

function PassphraseSection({
  onMessage,
}: {
  onMessage: (message: { tone: "success" | "error"; text: string }) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    if (next.length < 10) {
      onMessage({
        tone: "error",
        text: "The new passphrase needs at least 10 characters.",
      });
      return;
    }
    setBusy(true);
    try {
      await sendToBackground("session:rotate-passphrase", { current, next });
      onMessage({
        tone: "success",
        text: "Passphrase changed. Nothing was re-encrypted — only the key wrap changed.",
      });
    } catch (cause) {
      onMessage({
        tone: "error",
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
      setCurrent("");
      setNext("");
    }
  };

  return (
    <Section
      title="Passphrase"
      description="Changing it re-wraps the same encryption key, so your data is untouched. Your recovery code keeps working."
    >
      <TextField
        label="Current passphrase"
        type="password"
        value={current}
        onChange={setCurrent}
      />
      <TextField
        label="New passphrase"
        type="password"
        value={next}
        onChange={setNext}
      />
      <div className="col-span-full">
        <Button variant="primary" disabled={busy} onClick={() => void rotate()}>
          {busy ? "Changing…" : "Change passphrase"}
        </Button>
      </div>
    </Section>
  );
}
