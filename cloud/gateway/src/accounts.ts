import { randomToken, tokenHash } from "./crypto";
import type { Db, UserRow } from "./db";
import { MICROS_PER_CREDIT, SIGNUP_CREDITS } from "./plans";

const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {}

/** Accounts, sessions and the credit ledger. */
export class Accounts {
  /** A real hash to verify against when the email is unknown, so timing is the same. */
  private dummyHash = Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id" });

  constructor(private db: Db) {}

  async signup(email: string, password: string): Promise<UserRow> {
    email = email.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254)
      throw new AuthError("Enter a valid email address.");
    if (password.length < 10) throw new AuthError("Use a password of at least 10 characters.");
    if (this.byEmail(email)) throw new AuthError("An account with this email already exists.");
    const id = crypto.randomUUID();
    const pwHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const now = Date.now();
    this.db.run("INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)", [
      id,
      email,
      pwHash,
      now,
    ]);
    this.credit(id, SIGNUP_CREDITS * MICROS_PER_CREDIT, "signup_bonus", `signup:${id}`);
    return this.byId(id) as UserRow;
  }

  async login(email: string, password: string): Promise<UserRow> {
    const user = this.byEmail(email.trim().toLowerCase());
    const ok = await Bun.password
      .verify(password, user?.pw_hash ?? (await this.dummyHash))
      .catch(() => false);
    if (!user || !ok) throw new AuthError("Wrong email or password.");
    return user;
  }

  byEmail(email: string): UserRow | null {
    return this.db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(email);
  }

  byId(id: string): UserRow | null {
    return this.db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  }

  byStripeCustomer(customerId: string): UserRow | null {
    return this.db
      .query<UserRow, [string]>("SELECT * FROM users WHERE stripe_customer_id = ?")
      .get(customerId);
  }

  update(id: string, fields: Partial<Omit<UserRow, "id" | "created_at">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db.run(`UPDATE users SET ${sets} WHERE id = ?`, [
      ...keys.map((k) => (fields as Record<string, string | number | null>)[k]),
      id,
    ]);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM users WHERE id = ?", [id]);
  }

  /** New session; returns the bearer token (stored only as a hash). */
  createSession(userId: string, kind: "web" | "mobile"): string {
    const token = randomToken("ots_");
    const now = Date.now();
    this.db.run(
      "INSERT INTO sessions (token_hash, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      [tokenHash(token), userId, kind, now + SESSION_DAYS * 86_400_000, now],
    );
    return token;
  }

  userForSession(token: string | null | undefined): UserRow | null {
    if (!token) return null;
    const row = this.db
      .query<{ user_id: string; expires_at: number }, [string]>(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
      )
      .get(tokenHash(token));
    if (!row || row.expires_at < Date.now()) return null;
    return this.byId(row.user_id);
  }

  endSession(token: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
  }

  // ── credits ────────────────────────────────────────────────────────────────

  /** Append a ledger entry. A repeated `ref` (e.g. a Stripe event id) is a no-op. */
  credit(userId: string, deltaMicros: number, reason: string, ref: string | null = null): boolean {
    const res = this.db.run(
      "INSERT OR IGNORE INTO credit_ledger (user_id, delta_micros, reason, ref, at) VALUES (?, ?, ?, ?, ?)",
      [userId, Math.round(deltaMicros), reason, ref, Date.now()],
    );
    return res.changes > 0;
  }

  balanceMicros(userId: string): number {
    const row = this.db
      .query<{ s: number | null }, [string]>(
        "SELECT SUM(delta_micros) AS s FROM credit_ledger WHERE user_id = ?",
      )
      .get(userId);
    return row?.s ?? 0;
  }
}
