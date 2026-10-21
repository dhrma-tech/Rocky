import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "../store/db.ts";

/**
 * Paired devices (roadmap A3, docs/PHONE.md): a phone that reaches Rocky through Tailscale gets a
 * device cookie after typing a short pairing code shown on this computer. Only the token's
 * SHA-256 is stored, so the database never holds a usable credential.
 */

export const DEVICE_TTL_MS = 90 * 86_400_000;

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const toDevice = (r: Row): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
});

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new device and its token. The token is returned once, for the cookie, and never stored. */
export function createDevice(
  db: Db,
  name: string,
  now = Date.now(),
): { device: Device; token: string } {
  const token = randomBytes(32).toString("base64url");
  const id = ulid(now);
  db.prepare(
    "insert into devices (id, name, token_hash, created_at, expires_at) values (?, ?, ?, ?, ?)",
  ).run(id, name, hash(token), now, now + DEVICE_TTL_MS);
  return {
    device: toDevice(db.prepare("select * from devices where id = ?").get(id) as Row),
    token,
  };
}

/** The device a token belongs to, if it is current; records when it was last seen (per minute). */
export function verifyDeviceToken(db: Db, token: string, now = Date.now()): Device | null {
  if (!token) return null;
  const r = db
    .prepare("select * from devices where token_hash = ? and revoked_at is null and expires_at > ?")
    .get(hash(token), now) as Row | undefined;
  if (!r) return null;
  if (!r.last_seen_at || now - r.last_seen_at > 60_000) {
    db.prepare("update devices set last_seen_at = ? where id = ?").run(now, r.id);
    r.last_seen_at = now;
  }
  return toDevice(r);
}

export function listDevices(db: Db): Device[] {
  return (db.prepare("select * from devices order by created_at desc").all() as Row[]).map(
    toDevice,
  );
}

export function revokeDevice(db: Db, id: string, now = Date.now()): boolean {
  return (
    db.prepare("update devices set revoked_at = ? where id = ? and revoked_at is null").run(now, id)
      .changes > 0
  );
}
