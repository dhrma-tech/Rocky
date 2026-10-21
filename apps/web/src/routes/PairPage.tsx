import { useState } from "react";
import { devices, onAnotherDevice } from "../api.ts";
import { Banner, Button, Card, Input } from "../ui/index.tsx";

/**
 * Pair this phone (roadmap A3, docs/PHONE.md). Opened on the phone at https://<name>/pair; the
 * 6-digit code comes from Settings › Phone and devices on the computer. Works without a session:
 * it is the way in.
 */
export function PairPage() {
  const [code, setCode] = useState("");
  const [name, setName] = useState(() =>
    /iPhone|iPad/.test(navigator.userAgent)
      ? "iPhone"
      : /Android/.test(navigator.userAgent)
        ? "Android phone"
        : "Phone",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = code.replace(/\D/g, "").slice(0, 6);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await devices.pair(digits, name.trim() || "Phone");
      window.location.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="rk-page" style={{ maxWidth: 480 }}>
      <h1 className="rk-title">Pair this phone</h1>
      {!onAnotherDevice() && (
        <Banner tone="info" title="This page is for your phone.">
          On this computer you're already in. Open Settings › Phone and devices to make a code.
        </Banner>
      )}
      <Card>
        <form
          className="rk-pair"
          onSubmit={(e) => {
            e.preventDefault();
            if (digits.length === 6) void submit();
          }}
        >
          <p style={{ margin: 0 }}>
            On your computer, open Rocky's Settings › Phone and devices and make a pairing code.
          </p>
          <Input
            label="Pairing code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            value={digits}
            onChange={(e) => setCode(e.target.value)}
            error={error ?? undefined}
          />
          <Input
            label="Name for this phone"
            help="So you can tell it apart in the list on your computer."
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={digits.length !== 6}
            loading={busy && "Pairing…"}
          >
            Pair
          </Button>
        </form>
      </Card>
    </main>
  );
}
