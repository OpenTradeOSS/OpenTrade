import type { Config } from "./config";
import { randomToken, type Sealer, tokenHash } from "./crypto";
import type { Db, SandboxRow } from "./db";

/**
 * One sandbox per user: the OpenTrade host image with a persistent volume. Drivers:
 *   docker — local development (`docker run`, mapped port on 127.0.0.1)
 *   fly    — production (Fly Machines + a volume; reached over Fly's private network)
 */
export interface SandboxSpec {
  name: string;
  env: Record<string, string>;
}

export interface Placement {
  machineId: string;
  volumeId: string | null;
  /** Base URL of the sandbox edge, e.g. http://[fdaa::3]:8080 */
  address: string;
}

interface Driver {
  create(spec: SandboxSpec): Promise<Placement>;
  destroy(row: SandboxRow): Promise<void>;
  /** Point an existing sandbox at a new image (keeps its volume). */
  upgrade(row: SandboxRow, env: Record<string, string>): Promise<Placement>;
}

class DockerDriver implements Driver {
  constructor(private image: string) {}

  private async docker(args: string[]): Promise<string> {
    const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`docker ${args[0]} failed: ${err.trim()}`);
    return out.trim();
  }

  async create(spec: SandboxSpec): Promise<Placement> {
    const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const id = await this.docker([
      "run",
      "-d",
      "--name",
      spec.name,
      "--restart",
      "unless-stopped",
      "-v",
      `${spec.name}:/data`,
      "-p",
      "127.0.0.1::8080",
      "--add-host",
      "host.docker.internal:host-gateway",
      ...envArgs,
      this.image,
    ]);
    const port = (await this.docker(["port", id, "8080/tcp"])).split("\n")[0].split(":").pop();
    return { machineId: id.slice(0, 12), volumeId: spec.name, address: `http://127.0.0.1:${port}` };
  }

  async destroy(row: SandboxRow): Promise<void> {
    if (row.machine_id) await this.docker(["rm", "-f", row.machine_id]).catch(() => {});
    if (row.volume_id) await this.docker(["volume", "rm", "-f", row.volume_id]).catch(() => {});
  }

  async upgrade(row: SandboxRow, env: Record<string, string>): Promise<Placement> {
    if (row.machine_id) await this.docker(["rm", "-f", row.machine_id]).catch(() => {});
    return this.create({ name: row.volume_id ?? `ot-${row.user_id.slice(0, 8)}`, env });
  }
}

class FlyDriver implements Driver {
  private base: string;

  constructor(
    private app: string,
    private token: string,
    private image: string,
    private region: string,
  ) {
    this.base = `https://api.machines.dev/v1/apps/${app}`;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fly ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private machineConfig(env: Record<string, string>, volumeId: string) {
    return {
      image: this.image,
      env,
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
      mounts: [{ volume: volumeId, path: "/data" }],
      restart: { policy: "always" },
      metadata: { role: "opentrade-sandbox" },
    };
  }

  private async waitStarted(id: string): Promise<void> {
    await this.api("GET", `/machines/${id}/wait?state=started&timeout=60`).catch(() => {});
  }

  async create(spec: SandboxSpec): Promise<Placement> {
    const volume = await this.api<{ id: string }>("POST", "/volumes", {
      name: spec.name.replace(/[^a-z0-9_]/g, "_").slice(0, 30),
      region: this.region,
      size_gb: 1,
      encrypted: true,
    });
    const machine = await this.api<{ id: string; private_ip: string }>("POST", "/machines", {
      name: spec.name,
      region: this.region,
      config: this.machineConfig(spec.env, volume.id),
    });
    await this.waitStarted(machine.id);
    return {
      machineId: machine.id,
      volumeId: volume.id,
      address: `http://[${machine.private_ip}]:8080`,
    };
  }

  async destroy(row: SandboxRow): Promise<void> {
    if (row.machine_id) {
      await this.api("DELETE", `/machines/${row.machine_id}?force=true`).catch(() => {});
    }
    if (row.volume_id) {
      // A volume can't be deleted until its machine is gone; retry briefly.
      for (let i = 0; i < 10; i++) {
        try {
          await this.api("DELETE", `/volumes/${row.volume_id}`);
          return;
        } catch {
          await Bun.sleep(2000);
        }
      }
    }
  }

  async upgrade(row: SandboxRow, env: Record<string, string>): Promise<Placement> {
    if (!row.machine_id || !row.volume_id) throw new Error("sandbox has no machine");
    const machine = await this.api<{ id: string; private_ip: string }>(
      "POST",
      `/machines/${row.machine_id}`,
      {
        config: this.machineConfig(env, row.volume_id),
      },
    );
    await this.waitStarted(machine.id);
    return {
      machineId: machine.id,
      volumeId: row.volume_id,
      address: `http://[${machine.private_ip}]:8080`,
    };
  }
}

/** Owns the sandbox rows and their lifecycle. */
export class Sandboxes {
  private driver: Driver;
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private db: Db,
    private sealer: Sealer,
    private cfg: Config,
  ) {
    const s = cfg.sandbox;
    if (s.driver === "fly") {
      if (!s.flyToken) throw new Error("FLY_API_TOKEN is required for the fly driver");
      this.driver = new FlyDriver(s.flyApp, s.flyToken, s.image, s.flyRegion);
    } else {
      this.driver = new DockerDriver(s.image);
    }
  }

  get(userId: string): SandboxRow | null {
    return this.db
      .query<SandboxRow, [string]>("SELECT * FROM sandboxes WHERE user_id = ?")
      .get(userId);
  }

  /** The user whose sandbox presents this key (LLM proxy, sandbox events). */
  userForKey(key: string): string | null {
    const row = this.db
      .query<{ user_id: string }, [string]>("SELECT user_id FROM sandboxes WHERE key_hash = ?")
      .get(tokenHash(key));
    return row?.user_id ?? null;
  }

  edgeSecret(row: SandboxRow): string {
    return this.sealer.open(row.edge_secret);
  }

  private envFor(row: SandboxRow): Record<string, string> {
    const key = this.sealer.open(row.key_enc);
    const gw = this.cfg.sandbox.gatewayUrlForSandbox;
    return {
      OPENTRADE_EDGE_SECRET: this.edgeSecret(row),
      OPENTRADE_GATEWAY_URL: gw,
      OPENTRADE_PUBLIC_URL: this.cfg.publicUrl,
      OPENTRADE_SANDBOX_KEY: key,
      ANTHROPIC_BASE_URL: `${gw}/llm/anthropic`,
      ANTHROPIC_API_KEY: key,
      OPENAI_BASE_URL: `${gw}/llm/openai/v1`,
      OPENAI_API_KEY: key,
      ...(this.isDemo(row.user_id) ? { OPENTRADE_DEMO_APPROVALS: "1" } : {}),
    };
  }

  /** Demo accounts (App Review, screenshots) keep a sample order waiting for approval. */
  private isDemo(userId: string): boolean {
    if (!this.cfg.demoEmails.length) return false;
    const row = this.db
      .query<{ email: string }, [string]>("SELECT email FROM users WHERE id = ?")
      .get(userId);
    return row ? this.cfg.demoEmails.includes(row.email.toLowerCase()) : false;
  }

  /** Create the user's sandbox if it doesn't exist yet (idempotent, runs in the background). */
  ensure(userId: string): void {
    if (this.get(userId) || this.inflight.has(userId)) return;
    const now = Date.now();
    const key = randomToken("otk_");
    this.db.run(
      `INSERT INTO sandboxes (user_id, driver, edge_secret, key_hash, key_enc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)`,
      [
        userId,
        this.cfg.sandbox.driver,
        this.sealer.seal(randomToken("", 32)),
        tokenHash(key),
        this.sealer.seal(key),
        now,
        now,
      ],
    );
    const row = this.get(userId) as SandboxRow;
    const job = this.driver
      .create({ name: `ot-${userId.replace(/-/g, "").slice(0, 16)}`, env: this.envFor(row) })
      .then((p) => this.place(userId, p))
      .catch((err) => this.fail(userId, err))
      .finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, job);
  }

  /** Recreate a failed sandbox. */
  retry(userId: string): void {
    const row = this.get(userId);
    if (row?.status !== "error") return;
    this.db.run("DELETE FROM sandboxes WHERE user_id = ?", [userId]);
    void this.driver.destroy(row).finally(() => this.ensure(userId));
  }

  async upgrade(userId: string): Promise<void> {
    const row = this.get(userId);
    if (!row || row.status !== "running") return;
    const p = await this.driver.upgrade(row, this.envFor(row));
    await this.place(userId, p);
  }

  async destroy(userId: string): Promise<void> {
    await this.inflight.get(userId);
    const row = this.get(userId);
    if (!row) return;
    this.db.run("UPDATE sandboxes SET status = 'deleting', updated_at = ? WHERE user_id = ?", [
      Date.now(),
      userId,
    ]);
    await this.driver.destroy(row);
    this.db.run("DELETE FROM sandboxes WHERE user_id = ?", [userId]);
  }

  /** Wait for the sandbox edge to answer its health check. */
  async waitHealthy(address: string, timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${address}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return true;
      } catch {}
      await Bun.sleep(1000);
    }
    return false;
  }

  private async place(userId: string, p: Placement): Promise<void> {
    const healthy = await this.waitHealthy(p.address);
    this.db.run(
      `UPDATE sandboxes SET machine_id = ?, volume_id = ?, address = ?, status = ?, error = ?, updated_at = ?
       WHERE user_id = ?`,
      [
        p.machineId,
        p.volumeId,
        p.address,
        healthy ? "running" : "error",
        healthy ? null : "sandbox did not become healthy",
        Date.now(),
        userId,
      ],
    );
  }

  private fail(userId: string, err: unknown): void {
    console.error(`sandbox create failed for ${userId}:`, err);
    this.db.run(
      "UPDATE sandboxes SET status = 'error', error = ?, updated_at = ? WHERE user_id = ?",
      [String(err).slice(0, 500), Date.now(), userId],
    );
  }
}
