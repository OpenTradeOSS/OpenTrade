import { createHmac } from "node:crypto";
import type { Accounts } from "./accounts";
import { safeEqual } from "./crypto";
import type { Db, UserRow } from "./db";
import { CREDIT_PACKS, MICROS_PER_CREDIT, PLANS, type PlanId, planOf } from "./plans";

/**
 * Billing over Stripe's REST API (no SDK). Plans are subscriptions, credit packs are
 * one-time Checkout payments; both are resolved by Price lookup key (see
 * scripts/stripe-setup.ts). Credits are granted only from verified webhooks, each
 * ledger entry keyed by the Stripe object id so a redelivered event can't double-grant.
 */
export class Billing {
  constructor(
    private secretKey: string,
    private webhookSecret: string | null,
    private db: Db,
    private accounts: Accounts,
    private publicUrl: string,
  ) {}

  private async api<T = any>(
    method: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const body = params ? new URLSearchParams(params).toString() : undefined;
    const url =
      method === "GET" && body
        ? `https://api.stripe.com/v1${path}?${body}`
        : `https://api.stripe.com/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2025-09-30.clover",
      },
      body: method === "GET" ? undefined : body,
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`stripe ${path}: ${json?.error?.message ?? res.status}`);
    return json as T;
  }

  private priceIds = new Map<string, string>();

  private async priceId(lookupKey: string): Promise<string> {
    const cached = this.priceIds.get(lookupKey);
    if (cached) return cached;
    const list = await this.api("GET", "/prices", { "lookup_keys[]": lookupKey, active: "true" });
    const id = list.data?.[0]?.id;
    if (!id)
      throw new Error(
        `no active Stripe price with lookup key ${lookupKey} — run scripts/stripe-setup.ts`,
      );
    this.priceIds.set(lookupKey, id);
    return id;
  }

  private async customerFor(user: UserRow): Promise<string> {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const c = await this.api("POST", "/customers", {
      email: user.email,
      "metadata[user_id]": user.id,
    });
    this.accounts.update(user.id, { stripe_customer_id: c.id });
    return c.id;
  }

  /** Checkout URL for a plan subscription or a credit pack. */
  async checkout(user: UserRow, item: string): Promise<string> {
    const customer = await this.customerFor(user);
    const plan = PLANS[item as PlanId];
    const pack = CREDIT_PACKS.find((p) => p.id === item);
    const base: Record<string, string> = {
      customer,
      client_reference_id: user.id,
      success_url: `${this.publicUrl}/account?checkout=success`,
      cancel_url: `${this.publicUrl}/account?checkout=cancel`,
      "line_items[0][quantity]": "1",
      "metadata[user_id]": user.id,
      "metadata[item]": item,
      allow_promotion_codes: "true",
    };
    if (plan?.lookupKey) {
      if (user.stripe_subscription_id) return this.portal(user);
      const s = await this.api("POST", "/checkout/sessions", {
        ...base,
        mode: "subscription",
        "line_items[0][price]": await this.priceId(plan.lookupKey),
        "subscription_data[metadata][user_id]": user.id,
        "subscription_data[metadata][plan]": plan.id,
      });
      return s.url;
    }
    if (pack) {
      const s = await this.api("POST", "/checkout/sessions", {
        ...base,
        mode: "payment",
        "line_items[0][price]": await this.priceId(pack.lookupKey),
        "payment_intent_data[metadata][user_id]": user.id,
      });
      return s.url;
    }
    throw new Error(`unknown billing item ${item}`);
  }

  /** Stripe customer portal (change plan, cancel, invoices, payment method). */
  async portal(user: UserRow): Promise<string> {
    const customer = await this.customerFor(user);
    const s = await this.api("POST", "/billing_portal/sessions", {
      customer,
      return_url: `${this.publicUrl}/account`,
    });
    return s.url;
  }

  /** Verify `Stripe-Signature` (v1, 5-minute tolerance). */
  verify(payload: string, header: string | null): boolean {
    if (!this.webhookSecret || !header) return false;
    const parts = Object.fromEntries(
      header.split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${t}.${payload}`)
      .digest("hex");
    return header
      .split(",")
      .filter((kv) => kv.startsWith("v1="))
      .some((kv) => safeEqual(kv.slice(3), expected));
  }

  async webhook(
    payload: string,
    signature: string | null,
  ): Promise<{ status: number; body: string }> {
    if (!this.verify(payload, signature)) return { status: 400, body: "bad signature" };
    const event = JSON.parse(payload);
    const fresh = this.db.run("INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)", [
      event.id,
      Date.now(),
    ]);
    if (fresh.changes === 0) return { status: 200, body: "duplicate" };
    try {
      await this.apply(event);
    } catch (err) {
      // Let Stripe retry: forget the event so the retry isn't treated as a duplicate.
      this.db.run("DELETE FROM stripe_events WHERE id = ?", [event.id]);
      console.error("stripe webhook failed", event.type, err);
      return { status: 500, body: "error" };
    }
    return { status: 200, body: "ok" };
  }

  private userFor(obj: any): UserRow | null {
    const id = obj?.metadata?.user_id ?? obj?.client_reference_id;
    if (id) return this.accounts.byId(id);
    return obj?.customer ? this.accounts.byStripeCustomer(String(obj.customer)) : null;
  }

  private async apply(event: any): Promise<void> {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const user = this.userFor(obj);
        if (!user) return;
        if (obj.mode === "payment" && obj.payment_status === "paid") {
          const pack = CREDIT_PACKS.find((p) => p.id === obj.metadata?.item);
          if (pack)
            this.accounts.credit(
              user.id,
              pack.credits * MICROS_PER_CREDIT,
              `pack:${pack.id}`,
              `checkout:${obj.id}`,
            );
        }
        if (obj.mode === "subscription" && obj.subscription) {
          this.accounts.update(user.id, {
            stripe_customer_id: String(obj.customer),
            stripe_subscription_id: String(obj.subscription),
            plan: planOf(obj.metadata?.item).id,
          });
        }
        return;
      }
      case "invoice.paid": {
        // Every paid subscription invoice (first and renewals) grants the plan's credits.
        const user = this.userFor(obj) ?? this.accounts.byStripeCustomer(String(obj.customer));
        if (!user) return;
        if (!obj.parent?.subscription_details && !obj.subscription) return;
        const line = obj.lines?.data?.[0];
        // The plan rides on the subscription's metadata (set at checkout).
        const planId =
          obj.parent?.subscription_details?.metadata?.plan ??
          obj.subscription_details?.metadata?.plan ??
          line?.metadata?.plan ??
          user.plan;
        const plan = planOf(planId);
        if (plan.monthlyCredits > 0) {
          this.accounts.credit(
            user.id,
            plan.monthlyCredits * MICROS_PER_CREDIT,
            `plan:${plan.id}`,
            `invoice:${obj.id}`,
          );
        }
        this.accounts.update(user.id, {
          plan: plan.id,
          plan_renews_at: (line?.period?.end ?? 0) * 1000 || null,
        });
        return;
      }
      case "customer.subscription.updated": {
        const user = this.userFor(obj);
        if (!user) return;
        const planId = obj.metadata?.plan;
        if (obj.status === "active" && planId)
          this.accounts.update(user.id, { plan: planOf(planId).id });
        if (obj.status === "canceled" || obj.status === "unpaid") {
          this.accounts.update(user.id, { plan: "free", stripe_subscription_id: null });
        }
        return;
      }
      case "customer.subscription.deleted": {
        const user = this.userFor(obj);
        if (user)
          this.accounts.update(user.id, {
            plan: "free",
            stripe_subscription_id: null,
            plan_renews_at: null,
          });
        return;
      }
    }
  }

  async cancelSubscription(user: UserRow): Promise<void> {
    if (user.stripe_subscription_id) {
      await this.api("DELETE", `/subscriptions/${user.stripe_subscription_id}`).catch(() => {});
    }
  }
}
