import type { NotificationPrefs } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
  const heading = useId();

  return (
    <Card aria-labelledby={heading}>
      <h3 className="rk-h3" id={heading}>
        Phone notifications (ntfy)
      </h3>
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

/**
 * Telegram (D-066), off by default. The bot token goes to the keychain and is checked with
 * Telegram once. Only allowed user IDs are heard: the person who sends the bot /start shows up
 * here to be allowed with one click. Approve in the chat is a separate switch, low-risk writes only.
 */
export function TelegramChannel({
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
  const tg = prefs.telegram;
  const [token, setToken] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["channels"] });
  const saveToken = useMutation({
    mutationFn: channels.saveTelegramToken,
    onSuccess: (r) => {
      setToken("");
      refresh();
      toast({ text: r.bot ? `Connected to @${r.bot}.` : `Token saved. ${r.warning ?? ""}`.trim() });
    },
  });
  const forget = useMutation({
    mutationFn: channels.forgetTelegram,
    onSuccess: () => {
      refresh();
      toast({ text: "Bot token removed." });
    },
  });
  const test = useMutation({
    mutationFn: () => channels.test("telegram"),
    onSuccess: () => toast({ text: "Sent. Check Telegram." }),
    onError: (e) => toast({ text: e instanceof Error ? e.message : String(e) }),
  });
  const set = (patch: Partial<NotificationPrefs["telegram"]>) =>
    onSave({ ...prefs, telegram: { ...tg, ...patch } });
  const t = status.data?.telegram;
  const stranger = t?.stranger && !tg.userIds.includes(t.stranger.id) ? t.stranger : null;
  const here = !onAnotherDevice();
  const heading = useId();
  const localOnly = status.data?.localOnly ?? false;

  return (
    <Card aria-labelledby={heading}>
      <h3 className="rk-h3" id={heading}>
        Telegram
      </h3>
      <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
        Ask questions, check approvals and get notifications in a chat with your own bot. What you
        ask and what Rocky answers pass through Telegram. Rocky can't send, change or delete
        anything from the chat.
      </p>
      {localOnly && (
        <Banner tone="info" title="Local-only mode is on, so Telegram is off.">
          Turn local-only off in Privacy and data to use it.
        </Banner>
      )}
      <div className="rk-phone">
        {here && (
          <>
            <ol className="rk-steps">
              <li>In Telegram, message @BotFather, send /newbot and follow the steps.</li>
              <li>Paste the token it gives you here.</li>
              <li>Send /start to your new bot, then allow yourself below.</li>
            </ol>
            <div className="rk-device-add">
              <Input
                label={t?.tokenSet ? `Bot token (set${t.bot ? `, @${t.bot}` : ""})` : "Bot token"}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                error={saveToken.error?.message}
              />
              <Button
                disabled={!token.trim()}
                loading={saveToken.isPending && "Checking…"}
                onClick={() => saveToken.mutate(token.trim())}
              >
                Save token
              </Button>
            </div>
          </>
        )}
        <Switch
          label="Use Telegram"
          checked={tg.enabled}
          disabled={saving}
          onChange={(enabled) => set({ enabled })}
        />
        <div>
          <h4 className="rk-small" style={{ margin: "0 0 var(--space-2)", fontWeight: 600 }}>
            Who the bot listens to
          </h4>
          {tg.userIds.length === 0 && !stranger && (
            <p className="rk-small rk-muted" style={{ margin: 0 }}>
              Nobody yet. Send /start to your bot and your account shows up here.
            </p>
          )}
          <ul className="rk-device-list">
            {tg.userIds.map((id) => (
              <li key={id} className="rk-device">
                <span style={{ flex: 1 }}>
                  Telegram user <code className="rk-mono">{id}</code>
                </span>
                <Button
                  variant="tertiary"
                  dense
                  aria-label={`Stop listening to ${id}`}
                  disabled={saving}
                  onClick={() => set({ userIds: tg.userIds.filter((x) => x !== id) })}
                >
                  Remove
                </Button>
              </li>
            ))}
            {stranger && (
              <li className="rk-device">
                <span style={{ flex: 1 }}>
                  {stranger.name ? `@${stranger.name}` : "Someone"} (
                  <code className="rk-mono">{stranger.id}</code>) sent /start at{" "}
                  {new Date(stranger.at).toLocaleTimeString()}. Allow only if this is you.
                </span>
                <Button
                  dense
                  disabled={saving || tg.userIds.length >= 5}
                  onClick={() => set({ userIds: [...tg.userIds, stranger.id] })}
                >
                  Allow
                </Button>
              </li>
            )}
          </ul>
        </div>
        <Switch
          label="Approve low-risk drafts in the chat"
          checked={tg.approveLowRiskInChat}
          disabled={saving}
          onChange={(approveLowRiskInChat) => set({ approveLowRiskInChat })}
        />
        <p className="rk-small rk-muted" style={{ margin: 0 }}>
          Off: every approval has a Review button that opens Rocky. On: low-risk writes also get
          Approve, with the same 10-second Undo. Sends, spends, deletes and anything drafted from
          someone else's text always need Rocky itself.
        </p>
        <Switch
          label="Include details in notifications"
          checked={tg.details}
          disabled={saving}
          onChange={(details) => set({ details })}
        />
        <div className="rk-device-add">
          <Button
            disabled={!tg.enabled || !t?.tokenSet || !tg.userIds.length || localOnly}
            loading={test.isPending && "Sending…"}
            onClick={() => test.mutate()}
          >
            Send a test
          </Button>
          {here && t?.tokenSet && (
            <Button
              variant="tertiary"
              loading={forget.isPending && "Removing…"}
              onClick={() => forget.mutate()}
            >
              Forget bot token
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
