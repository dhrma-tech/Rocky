import type { NotificationPrefs } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { channels, onAnotherDevice } from "../api.ts";
import { Banner, Button, Card, Input, Switch, useToast } from "../ui/index.tsx";

/**
 * Phone notifications through ntfy (D-065), off by default. The topic works like a password on a
 * public server, so it goes to the keychain and is never shown again; Rocky only says whether one
 * is set. Without "Include details" the phone hears only what kind of thing is waiting.
 */

/** A topic nobody will guess: "rocky_" and 20 random letters and digits. */
function randomTopic(): string {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `rocky_${[...bytes].map((b) => abc[b % abc.length]).join("")}`;
}

export function PhoneChannel({
  prefs,
  saving,
  onSave,
}: {
  prefs: NotificationPrefs;
  saving: boolean;
  onSave: (p: NotificationPrefs) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["channels"], queryFn: channels.get });
  const ntfy = prefs.ntfy;
  const [server, setServer] = useState(ntfy.server);
  const [topic, setTopic] = useState("");
  const [token, setToken] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["channels"] });
  const saveSecret = useMutation({
    mutationFn: ({ name, value }: { name: "topic" | "token"; value: string }) =>
      channels.setSecret(name, value),
    onSuccess: (_r, v) => {
      if (v.name === "topic") setTopic("");
      else setToken("");
      refresh();
      toast({ text: v.name === "topic" ? "Topic saved to your keychain." : "Token saved." });
    },
  });
  const forget = useMutation({
    mutationFn: channels.forget,
    onSuccess: () => {
      refresh();
      toast({ text: "Topic and token removed." });
    },
  });
  const test = useMutation({
    mutationFn: channels.test,
    onSuccess: () => toast({ text: "Sent. It should show on your phone in a few seconds." }),
    onError: (e) => toast({ text: e instanceof Error ? e.message : String(e) }),
  });
  const set = (patch: Partial<NotificationPrefs["ntfy"]>) =>
    onSave({ ...prefs, ntfy: { ...ntfy, ...patch } });
  const localOnly = status.data?.localOnly ?? false;
  const topicSet = status.data?.ntfy.topicSet ?? false;
  const here = !onAnotherDevice();

  return (
    <Card>
      <h3 className="rk-h3">Phone notifications (ntfy)</h3>
      <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
        ntfy is a free app that shows notifications sent to a topic. Install it on your phone and
        subscribe to the topic you set here. Messages pass through the ntfy server you choose.
      </p>
      {localOnly && (
        <Banner tone="info" title="Local-only mode is on, so nothing goes to your phone.">
          Turn local-only off in Privacy and data to use phone notifications.
        </Banner>
      )}
      {status.isError && (
        <Banner tone="warning" title="Couldn't check the phone channel.">
          {status.error.message}
        </Banner>
      )}
      <div className="rk-phone">
        <Switch
          label="Send notifications to my phone"
          checked={ntfy.enabled}
          disabled={saving}
          onChange={(enabled) => set({ enabled })}
        />
        {here && (
          <>
            <div className="rk-device-add">
              <Input
                label={topicSet ? "Topic (set; type a new one to replace it)" : "Topic"}
                help="Anyone who knows the topic can read the messages, so make it long and random."
                value={topic}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTopic(e.target.value)}
                error={
                  saveSecret.variables?.name === "topic" ? saveSecret.error?.message : undefined
                }
              />
              <Button variant="tertiary" onClick={() => setTopic(randomTopic())}>
                Make one for me
              </Button>
              <Button
                disabled={!topic.trim()}
                loading={
                  saveSecret.isPending && saveSecret.variables?.name === "topic" && "Saving…"
                }
                onClick={() => saveSecret.mutate({ name: "topic", value: topic.trim() })}
              >
                Save topic
              </Button>
            </div>
            <div className="rk-device-add">
              <Input
                label="Server"
                help="https://ntfy.sh, or your own ntfy server."
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
              <Button
                disabled={saving || server.trim() === ntfy.server}
                onClick={() => set({ server: server.trim() })}
              >
                Save server
              </Button>
            </div>
            <div className="rk-device-add">
              <Input
                label={
                  status.data?.ntfy.tokenSet
                    ? "Access token (set; optional)"
                    : "Access token (optional)"
                }
                help="Only if your ntfy server needs one."
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button
                disabled={!token.trim()}
                loading={
                  saveSecret.isPending && saveSecret.variables?.name === "token" && "Saving…"
                }
                onClick={() => saveSecret.mutate({ name: "token", value: token.trim() })}
              >
                Save token
              </Button>
            </div>
          </>
        )}
        <Switch
          label="Include details"
          checked={ntfy.details}
          disabled={saving}
          onChange={(details) => set({ details })}
        />
        <p className="rk-small rk-muted" style={{ margin: 0 }}>
          {ntfy.details
            ? "Messages say what is waiting, such as the draft's title. That text passes through the ntfy server."
            : 'Messages say only the kind of thing, such as "An approval is waiting for you."'}
        </p>
        <div className="rk-device-add">
          <Button
            disabled={!ntfy.enabled || !topicSet || localOnly}
            loading={test.isPending && "Sending…"}
            onClick={() => test.mutate()}
          >
            Send a test
          </Button>
          {here && topicSet && (
            <Button
              variant="tertiary"
              loading={forget.isPending && "Removing…"}
              onClick={() => forget.mutate()}
            >
              Forget topic and token
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
