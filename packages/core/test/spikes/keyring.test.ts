// Spike 5: OS keychain via @napi-rs/keyring (Windows Credential Manager here).
// Skipped on Linux CI, which has no secret service.
import { Entry } from "@napi-rs/keyring";
import { describe, expect, it } from "vitest";

const skip = process.env.ROCKY_CI === "1" && process.platform === "linux";

describe.skipIf(skip)("spike: keyring", () => {
  it("sets, gets and deletes a secret", () => {
    const entry = new Entry("rocky-test", `spike-${process.pid}`);
    entry.setPassword("s3cret-value");
    expect(entry.getPassword()).toBe("s3cret-value");
    expect(entry.deletePassword()).toBe(true);
    expect(entry.getPassword()).toBeNull();
  });
});
