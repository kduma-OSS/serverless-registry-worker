import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../../src/core/signing";
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "../../src/core/totp";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890", the last six digits of each code.
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("base32", () => {
  it("round-trips bytes and ignores case, spaces and padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base32Encode(bytes);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode(`${encoded.toLowerCase().slice(0, 4)} ${encoded.slice(4)}==`)).toEqual(
      bytes,
    );
  });

  it("encodes the RFC 4648 examples", () => {
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(new TextEncoder().encode("f"))).toBe("MY");
  });

  it("rejects characters outside the alphabet", () => {
    expect(base32Decode("AB1C")).toBeNull();
    expect(base32Decode("AB!C")).toBeNull();
  });
});

describe("totp", () => {
  it.each(RFC_VECTORS)("matches the RFC 6238 vector at %i", async (seconds, expected) => {
    expect(await totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(expected);
  });

  it("generates 160-bit secrets", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it("accepts the current step and one on each side, not further", async () => {
    const now = 1111111109 * 1000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const code = (await totpCode(RFC_SECRET, step + offset)) ?? "";
      expect(await verifyTotp(RFC_SECRET, code, now, 0)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      const code = (await totpCode(RFC_SECRET, step + offset)) ?? "";
      expect(await verifyTotp(RFC_SECRET, code, now, 0)).toBeNull();
    }
  });

  it("never accepts a step twice", async () => {
    const now = 1111111109 * 1000;
    const step = totpStep(now);
    const code = (await totpCode(RFC_SECRET, step)) ?? "";
    expect(await verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(await verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, code, now, step + 5)).toBeNull();
  });

  it("ignores spaces in a code and refuses anything but six digits", async () => {
    const now = 59_000;
    const code = (await totpCode(RFC_SECRET, totpStep(now))) ?? "";
    expect(await verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now, 0)).not.toBe(
      null,
    );
    for (const bad of ["", "12345", "1234567", "abcdef", "28708a"]) {
      expect(await verifyTotp(RFC_SECRET, bad, now, 0)).toBeNull();
    }
    expect(await verifyTotp("not base32!", code, now, 0)).toBeNull();
  });

  it("builds the otpauth URI", () => {
    const uri = otpauthUri("registry.test", "shop frontend", "JBSWY3DPEHPK3PXP");
    expect(uri.startsWith("otpauth://totp/registry.test:shop%20frontend?")).toBe(true);
    const query = new URL(uri).searchParams;
    expect(query.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(query.get("issuer")).toBe("registry.test");
    expect(query.get("period")).toBe("30");
    expect(query.get("digits")).toBe("6");
  });
});

describe("stored secrets", () => {
  const env = { SESSION_SECRET: "totp-test-secret" };

  it("encrypts with a random IV and decrypts again", async () => {
    const secret = generateTotpSecret();
    const a = await encryptTotpSecret(env, secret);
    const b = await encryptTotpSecret(env, secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await decryptTotpSecret(env, a)).toBe(secret);
  });

  it("does not decrypt with another SESSION_SECRET or a damaged value", async () => {
    const stored = await encryptTotpSecret(env, "JBSWY3DPEHPK3PXP");
    expect(await decryptTotpSecret({ SESSION_SECRET: "other" }, stored)).toBeNull();
    const damaged = stored.split(".");
    const ciphertext = base64UrlDecode(damaged[2] ?? "");
    if (ciphertext === null || ciphertext.length === 0) throw new Error("Ciphertext missing");
    // Replacing a Base64 suffix can leave randomly generated ciphertext unchanged.
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    damaged[2] = base64UrlEncode(ciphertext);
    expect(await decryptTotpSecret(env, damaged.join("."))).toBeNull();
    expect(await decryptTotpSecret(env, "v2.a.b")).toBeNull();
    expect(await decryptTotpSecret(env, "nonsense")).toBeNull();
  });

  it("needs SESSION_SECRET", async () => {
    await expect(encryptTotpSecret({}, "JBSWY3DPEHPK3PXP")).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});
