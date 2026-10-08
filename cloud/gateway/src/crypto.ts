import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secrets at rest (BYOK provider keys, sandbox edge secrets and keys) are sealed with
 * AES-256-GCM under the gateway master key. Format: `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
export class Sealer {
  private key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) throw new Error("master key must be 32 bytes");
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, ct]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("bad sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

/** Lookup hash for bearer tokens: tokens are high-entropy, so a fast hash is enough. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
