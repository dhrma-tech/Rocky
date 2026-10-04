import { Entry } from "@napi-rs/keyring";

/** Round-trips a throwaway secret to prove the OS keychain is usable. */
export function keychainStatus(): { ok: true } | { ok: false; error: string } {
  const entry = new Entry("rocky", `doctor-probe-${process.pid}`);
  try {
    entry.setPassword("probe");
    const ok = entry.getPassword() === "probe";
    entry.deletePassword();
    return ok ? { ok: true } : { ok: false, error: "read-back mismatch" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
