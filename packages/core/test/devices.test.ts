// Paired devices (D-064): only the token's hash is stored; expiry and revocation lock a device out.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDevice,
  type Db,
  DEVICE_TTL_MS,
  listDevices,
  revokeDevice,
  verifyDeviceToken,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("devices", () => {
  it("stores a hash, not the token, and verifies until expiry", () => {
    const { device, token } = createDevice(db, "Phone", 1000);
    const stored = db.prepare("select token_hash from devices").get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeviceToken(db, token, 2000)?.id).toBe(device.id);
    expect(verifyDeviceToken(db, `${token}x`, 2000)).toBeNull();
    expect(verifyDeviceToken(db, "", 2000)).toBeNull();
    expect(verifyDeviceToken(db, token, 1000 + DEVICE_TTL_MS)).toBeNull();
  });

  it("records last seen at most once a minute, and revoking ends it", () => {
    const { device, token } = createDevice(db, "Phone", 0);
    verifyDeviceToken(db, token, 10_000);
    verifyDeviceToken(db, token, 20_000);
    expect(listDevices(db)[0]?.lastSeenAt).toBe(10_000);
    verifyDeviceToken(db, token, 80_000);
    expect(listDevices(db)[0]?.lastSeenAt).toBe(80_000);
    expect(revokeDevice(db, device.id, 90_000)).toBe(true);
    expect(revokeDevice(db, device.id, 91_000)).toBe(false);
    expect(verifyDeviceToken(db, token, 92_000)).toBeNull();
  });
});
