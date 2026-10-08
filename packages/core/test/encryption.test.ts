import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dataPaths,
  encryptStore,
  isEncryptedFile,
  loadAppConfig,
  memorySecrets,
  openRuntime,
  type SecretStore,
  storageStatus,
  upsertDocument,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";
import { HW_HIGH } from "./router-helpers.ts";

const MARKER = "the-secret-launch-date-is-the-ninth-of-november";
const hardware = { ...HW_HIGH, platform: "win32" as const, release: "x", cpu: "x", cores: 4 };
let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function withRuntime(
  secrets: SecretStore,
  fn?: (rt: Awaited<ReturnType<typeof openRuntime>>) => void,
) {
  const rt = await openRuntime({ dataDir: dir, secrets, hardware });
  try {
    fn?.(rt);
    rt.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    rt.close();
  }
}

const seed = (rt: Awaited<ReturnType<typeof openRuntime>>) =>
  upsertDocument(rt.db, {
    parsed: {
      title: "Plans",
      sourceType: "text",
      text: MARKER,
      units: [
        {
          anchor: { kind: "text" },
          start: 0,
          end: MARKER.length,
          blocks: [{ type: "para", start: 0, end: MARKER.length }],
        },
      ],
    },
    externalId: "plans",
  });

const plaintextOnDisk = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("rocky.db"))
    .some((f) => fs.readFileSync(path.join(dir, f)).includes(MARKER));

describe("encrypted store (opt-in)", () => {
  it("a new store with storage.encrypt gets a keychain key and no plaintext on disk", async () => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, "rocky.yaml"), "storage:\n  encrypt: true\n");
    const secrets = memorySecrets();
    await withRuntime(secrets, seed);
    expect(secrets.get("db-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(isEncryptedFile(dataPaths(dir).db)).toBe(true);
    expect(plaintextOnDisk()).toBe(false);
    await withRuntime(secrets, (rt) => {
      expect(rt.db.prepare("select title from documents").get()).toEqual({ title: "Plans" });
    });
  });

  it("refuses to open without the key, and explains a plain open of an encrypted file", async () => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, "rocky.yaml"), "storage:\n  encrypt: true\n");
    const secrets = memorySecrets();
    await withRuntime(secrets, seed);
    await expect(openRuntime({ dataDir: dir, secrets: memorySecrets(), hardware })).rejects.toThrow(
      /key \(db-key\) is not in the keychain/,
    );
    await expect(
      openRuntime({
        dataDir: dir,
        secrets: memorySecrets({ "db-key": "f".repeat(64) }),
        hardware,
      }),
    ).rejects.toThrow(/does not match/);
    fs.writeFileSync(path.join(dir, "rocky.yaml"), "storage:\n  encrypt: false\n");
    await expect(openRuntime({ dataDir: dir, secrets, hardware })).rejects.toThrow(
      /looks encrypted, but storage.encrypt is off/,
    );
  });

  it("rocky db encrypt converts a plain store and its backups, then turns the setting on", async () => {
    dir = tempDir();
    const secrets = memorySecrets();
    await withRuntime(secrets, seed);
    expect(plaintextOnDisk()).toBe(true);
    const paths = dataPaths(dir);
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.copyFileSync(paths.db, path.join(paths.backups, "rocky-1-1.db"));
    expect(storageStatus(dir, loadAppConfig(dir))).toEqual({ configured: false, encrypted: false });

    expect(encryptStore(dir, secrets)).toEqual({ backupsEncrypted: 1 });
    expect(plaintextOnDisk()).toBe(false);
    expect(fs.readFileSync(path.join(paths.backups, "rocky-1-1.db")).includes(MARKER)).toBe(false);
    expect(storageStatus(dir, loadAppConfig(dir))).toEqual({ configured: true, encrypted: true });
    await withRuntime(secrets, (rt) => {
      expect(rt.db.prepare("select raw_text from documents").get()).toEqual({ raw_text: MARKER });
    });
    expect(() => encryptStore(dir, secrets)).toThrow(/already encrypted/);
  });
});

describe("encryption on by default for new stores (M5)", () => {
  it("turns it on for a brand-new data dir and keeps the key in the keychain", async () => {
    const { encryptNewStore } = await import("../src/store/encryption.ts");
    const { loadAppConfig } = await import("../src/config/load.ts");
    const { dataPaths } = await import("../src/config/paths.ts");
    const { memorySecrets } = await import("../src/secrets/keychain.ts");
    const dir = tempDir();
    const secrets = memorySecrets();
    const c = encryptNewStore(dir, loadAppConfig(dir), secrets, dataPaths(dir).db);
    expect(c.storage.encrypt).toBe(true);
    expect(loadAppConfig(dir).storage.encrypt).toBe(true);
    expect(secrets.get("db-key")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves an existing plain store, an explicit choice, and a broken keychain alone", async () => {
    const { encryptNewStore } = await import("../src/store/encryption.ts");
    const { loadAppConfig, saveAppConfig } = await import("../src/config/load.ts");
    const { dataPaths } = await import("../src/config/paths.ts");
    const { memorySecrets } = await import("../src/secrets/keychain.ts");
    // Existing plain store: only `rocky db encrypt` converts it.
    const a = tempDir();
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(dataPaths(a).db, "x");
    expect(
      encryptNewStore(a, loadAppConfig(a), memorySecrets(), dataPaths(a).db).storage.encrypt,
    ).toBe(false);
    // The user said no.
    const b = tempDir();
    saveAppConfig(b, { ...loadAppConfig(b), storage: { encrypt: false } });
    expect(
      encryptNewStore(b, loadAppConfig(b), memorySecrets(), dataPaths(b).db).storage.encrypt,
    ).toBe(false);
    // No working keychain (common on CI Linux): stay plain rather than lose the key.
    const c = tempDir();
    const broken = {
      ...memorySecrets(),
      set: () => {
        throw new Error("no secret service");
      },
    };
    expect(encryptNewStore(c, loadAppConfig(c), broken, dataPaths(c).db).storage.encrypt).toBe(
      false,
    );
    expect(fs.existsSync(dataPaths(c).config)).toBe(false);
  });
});
