import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { devices, onAnotherDevice, type PairedDevice } from "../api.ts";
import {
  Banner,
  Button,
  Card,
  ErrorState,
  Input,
  Modal,
  Skeleton,
  useToast,
} from "../ui/index.tsx";

/**
 * Settings › Phone and devices (roadmap A3, docs/PHONE.md). Rocky listens on this computer only;
 * a phone reaches it through Tailscale, which keeps the connection private and encrypted. The
 * names a phone may use and pairing codes are managed here, on the computer, never from a phone.
 */
export function DevicesSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["devices"], queryFn: devices.list });
  const [revoking, setRevoking] = useState<PairedDevice | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => devices.revoke(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ["devices"] });
      toast({ text: "That phone is signed out of Rocky." });
    },
  });
  const away = onAnotherDevice();

  if (list.isPending) return <Skeleton rows={3} />;
  if (list.isError)
    return (
      <ErrorState
        title="Couldn't read the paired devices."
        happened={list.error.message}
        fix={<Button onClick={() => void list.refetch()}>Retry</Button>}
      />
    );
  const { hosts, port } = list.data;
  return (
    <div className="rk-devices">
      {away ? (
        <Banner tone="info" title="You're on a paired device.">
          Names and pairing codes are managed on the computer Rocky runs on.
        </Banner>
      ) : (
        <>
          <Card>
            <h3 className="rk-h3">Reach Rocky from your phone</h3>
            <ol className="rk-steps">
              <li>
                Install Tailscale on this computer and on your phone, signed in to the same account.
                It connects them privately; nothing is opened to the internet.
              </li>
              <li>
                On this computer, run <code className="rk-mono">tailscale serve {port}</code>. It
                prints an address like <code className="rk-mono">https://pc.tail1234.ts.net</code>.
              </li>
              <li>Add that name below, then make a pairing code.</li>
            </ol>
          </Card>
          <HostList hosts={hosts} />
          <PairCode hosts={hosts} />
        </>
      )}
      <Card>
        <h3 className="rk-h3">Paired devices</h3>
        {list.data.devices.length === 0 ? (
          <p className="rk-muted" style={{ margin: 0 }}>
            No phone is paired yet.
          </p>
        ) : (
          <ul className="rk-device-list">
            {list.data.devices.map((d) => {
              const gone = d.revokedAt !== null || d.expiresAt <= Date.now();
              return (
                <li key={d.id} className="rk-device" data-gone={gone}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{d.name}</strong>
                    <span className="rk-small rk-muted rk-block">
                      Paired {new Date(d.createdAt).toLocaleDateString()}
                      {d.lastSeenAt
                        ? ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}`
                        : " · not used yet"}
                      {d.revokedAt !== null
                        ? " · signed out"
                        : d.expiresAt <= Date.now()
                          ? " · expired, pair again"
                          : ` · until ${new Date(d.expiresAt).toLocaleDateString()}`}
                    </span>
                  </div>
                  {!gone && (
                    <Button variant="tertiary" dense onClick={() => setRevoking(d)}>
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Sign out ${revoking?.name ?? "this device"}?`}
        actions={
          <>
            <Button variant="tertiary" onClick={() => setRevoking(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending && "Signing out…"}
              onClick={() => revoking && revoke.mutate(revoking.id)}
            >
              Sign out
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          It stops reaching Rocky at once. Pair it again with a new code if you need it.
        </p>
      </Modal>
    </div>
  );
}

function HostList({ hosts }: { hosts: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: devices.saveHosts,
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["devices"] });
      toast({ text: "Saved." });
    },
  });
  const name = draft
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return (
    <Card>
      <h3 className="rk-h3">Names your phone may use</h3>
      {hosts.length > 0 && (
        <ul className="rk-device-list">
          {hosts.map((h) => (
            <li key={h} className="rk-device">
              <code className="rk-mono" style={{ flex: 1, overflowWrap: "anywhere" }}>
                {h}
              </code>
              <Button
                variant="tertiary"
                dense
                aria-label={`Remove ${h}`}
                onClick={() => save.mutate(hosts.filter((x) => x !== h))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="rk-device-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) save.mutate([...hosts, name]);
        }}
      >
        <Input
          label="Name from tailscale serve"
          placeholder="pc.tail1234.ts.net"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          error={save.error?.message}
        />
        <Button type="submit" disabled={!name} loading={save.isPending && "Saving…"}>
          Add
        </Button>
      </form>
    </Card>
  );
}

function PairCode({ hosts }: { hosts: string[] }) {
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const make = useMutation({ mutationFn: devices.pairCode, onSuccess: setPair });
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  return (
    <Card>
      <h3 className="rk-h3">Pair a phone</h3>
      {pair && left > 0 ? (
        <>
          <p style={{ marginTop: 0 }}>
            On the phone, open{" "}
            <code className="rk-mono" style={{ overflowWrap: "anywhere" }}>
              https://{hosts[0]}/pair
            </code>{" "}
            and type this code:
          </p>
          <p className="rk-pair-code">
            <span aria-hidden="true">{pair.code}</span>
            {/* Read digit by digit, not as a number. */}
            <span className="sr-only">Pairing code {pair.code.split("").join(" ")}</span>
          </p>
          <p className="rk-small rk-muted" aria-live="polite">
            Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more. Five
            wrong tries end it.
          </p>
        </>
      ) : (
        <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
          {hosts.length
            ? "The code works once, for five minutes."
            : "Add the name your phone will use first."}
        </p>
      )}
      <Button
        variant="primary"
        disabled={!hosts.length}
        loading={make.isPending && "Making a code…"}
        onClick={() => make.mutate()}
      >
        {pair && left > 0 ? "Make a new code" : "Make a pairing code"}
      </Button>
    </Card>
  );
}
