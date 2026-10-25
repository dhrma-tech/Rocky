import { describe, expect, it } from "vitest";
import { luhn, sensitiveTags } from "../src/security/sensitive.ts";

describe("sensitive tags for the outbound preview", () => {
  it("finds the classes it names", () => {
    expect(sensitiveTags("Mail dana@example.com about it")).toEqual(["email"]);
    expect(sensitiveTags("Call me on +91 98765 43210 tonight")).toEqual(["phone"]);
    expect(sensitiveTags("Card 4111 1111 1111 1111 exp 12/29")).toEqual(["card_number"]);
    expect(sensitiveTags("Pay to GB82 WEST 1234 5698 7654 32")).toEqual(["iban"]);
    expect(sensitiveTags("SSN 123-45-6789")).toEqual(["id_number"]);
    expect(sensitiveTags("PAN ABCDE1234F on file")).toEqual(["id_number"]);
    expect(sensitiveTags("the wifi password: hunter22")).toEqual(["secret"]);
    expect(sensitiveTags("key sk-ant-api03-abcdefghijklmnop1234")).toEqual(["secret"]);
    expect(sensitiveTags("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["secret"]);
  });

  it("leaves ordinary text, dates, prices and order numbers alone", () => {
    expect(sensitiveTags("The Acme contract renews on 2026-03-01 at $12,000 per year.")).toEqual(
      [],
    );
    expect(sensitiveTags("Order 1234567890123 shipped")).toEqual([]);
    expect(sensitiveTags("Meeting at 10:30 in room 4.12")).toEqual([]);
  });

  it("checks card numbers with Luhn", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
});
