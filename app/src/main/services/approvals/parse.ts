import type { OrderOutcome, ParsedOrder } from "@shared/approval";
import {
  legsLabel,
  type OptionContract,
  type OptionLeg,
  STANDARD_MULTIPLIER,
} from "@shared/options";

/**
 * Best-effort parse of a Robinhood order tool's `tool_input` into a human card.
 * The exact field shapes are only partially confirmed, so every field is a
 * lenient lookup over candidate keys and may come back null — the rawInput on the
 * approval row is always the source of truth.
 */
export function parseOrderInput(toolName: string, input: unknown): ParsedOrder {
  const o = (input ?? {}) as Record<string, unknown>;
  // Exercise first: `cancel_option_exercise` would otherwise trip the generic
  // cancel branch, which expects an order_id it doesn't have (it targets an
  // option_id — exercises aren't orders and never appear in the order ledger).
  if (/exercise/.test(toolName)) return parseExercise(toolName, o);
  const isCancel = /cancel_/.test(toolName);
  const isOption = /_option_/.test(toolName) || Array.isArray(o.legs);
  const isCrypto = /_crypto_/.test(toolName);

  if (isCancel) {
    const orderId = str(pick(o, "order_id", "id", "orderId"));
    return {
      kind: "cancel",
      symbol: str(pick(o, "symbol", "ticker")),
      side: null,
      quantity: null,
      orderType: "cancel",
      limitPrice: null,
      estCost: null,
      cancelsOrderId: orderId,
      summary: orderId ? `Cancel order ${orderId}` : "Cancel order",
      ...(isOption ? { assetType: "option" as const } : {}),
      ...(isCrypto ? { assetType: "crypto" as const } : {}),
    };
  }

  if (isOption) return parseOptionOrder(o);

  // Equity and crypto orders share a flat shape (symbol/side/type/quantity or a
  // dollar notional). Crypto extras: the symbol may be a pair ("BTC-USD" → "BTC"),
  // quantities are coins, and `stop_loss` is what equities call `stop_market`.
  const rawSymbol = up(str(pick(o, "symbol", "ticker", "instrument")));
  const symbol = isCrypto && rawSymbol ? rawSymbol.replace(/-?USD$/, "") : rawSymbol;
  const side = low(str(pick(o, "side", "direction")));
  const quantity = numv(pick(o, "quantity", "qty", "shares", "amount_in_shares"));
  const orderType = low(str(pick(o, "type", "order_type", "orderType"))) ?? inferType(o);
  const limitPrice = numv(pick(o, "limit_price", "limitPrice", "price"));
  const stopPrice = numv(pick(o, "stop_price", "stopPrice"));
  const dollars = numv(pick(o, "amount", "dollar_amount", "amount_in_dollars", "notional"));

  let estCost: number | null = null;
  if (limitPrice != null && quantity != null) estCost = limitPrice * quantity;
  else if (dollars != null) estCost = dollars;

  return {
    kind: "place",
    symbol,
    side,
    quantity,
    orderType,
    limitPrice,
    estCost,
    cancelsOrderId: null,
    summary: placeSummary({
      side,
      quantity,
      symbol,
      orderType,
      limitPrice,
      stopPrice,
      dollars,
      estCost,
    }),
    ...(isCrypto ? { assetType: "crypto" as const, stopPrice } : {}),
  };
}

/**
 * An option order's `tool_input` (`place_option_order`). Unlike an equity order it
 * names no symbol: each leg carries only an `option_id` UUID, the price is per
 * share and `quantity` counts contracts. The contract's identity (underlying,
 * expiry, strike, call/put) is filled in afterwards by `enrichOptionParsed`, once
 * the gate has resolved the ids — so this first pass renders `BUY 1 option to open
 * @ $0.79 limit`, and the enriched card `BUY 1 TLT $86C 11/20/26 to open …`.
 *
 * Field shapes verified against the live tool schema (2026-08-27): `legs[]
 * {option_id, side, position_effect, ratio_quantity?}`, `quantity`, `type`
 * (limit default), `price`, `stop_price`, `direction` (multi-leg), `time_in_force`.
 */
function parseOptionOrder(o: Record<string, unknown>): ParsedOrder {
  const rawLegs = Array.isArray(o.legs) ? (o.legs as unknown[]) : [];
  const legs: OptionLeg[] = rawLegs.map((raw) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    return {
      optionId: str(pick(l, "option_id", "optionId", "id")) ?? "",
      side: low(str(pick(l, "side"))),
      positionEffect: low(str(pick(l, "position_effect", "positionEffect"))),
      ratioQuantity: numv(pick(l, "ratio_quantity", "ratioQuantity")) ?? 1,
      contract: null,
    };
  });
  const quantity = numv(pick(o, "quantity", "qty"));
  // RH defaults `type` to limit; a bare `price` means the same.
  const orderType =
    low(str(pick(o, "type", "order_type", "orderType"))) ??
    (pick(o, "price", "limit_price") != null ? "limit" : null);
  const limitPrice = numv(pick(o, "price", "limit_price", "limitPrice"));
  const stopPrice = numv(pick(o, "stop_price", "stopPrice"));
  // One leg: its side is the order's side. A spread only has a net direction
  // (debit = you pay, credit = you receive), which stands in as the verb.
  const direction =
    low(str(pick(o, "direction"))) ??
    (legs.length === 1 && legs[0].side ? (legs[0].side === "sell" ? "credit" : "debit") : null);
  const side = legs.length === 1 ? legs[0].side : direction;
  return buildOptionParsed({ legs, quantity, orderType, limitPrice, stopPrice, direction, side });
}

/**
 * `exercise_option` / `cancel_option_exercise`. Not orders: the input names a
 * position's contract by `option_id` (+ integer `quantity` for the exercise
 * itself; the cancel targets every queued exercise on that contract). A call
 * exercise buys `quantity × multiplier` shares at the strike, so once the
 * contract resolves the est. cost is `strike × multiplier × quantity` (a put
 * delivers shares instead — no cash estimate). `allow_shorts` on a put is a
 * risk flag worth keeping on the card.
 */
function parseExercise(toolName: string, o: Record<string, unknown>): ParsedOrder {
  const optionId = str(pick(o, "option_id", "optionId")) ?? "";
  const legs: OptionLeg[] = optionId
    ? [{ optionId, side: null, positionEffect: null, ratioQuantity: 1, contract: null }]
    : [];
  return buildExerciseParsed({
    cancel: /cancel_/.test(toolName),
    legs,
    quantity: numv(pick(o, "quantity")),
    allowShorts: pick(o, "allow_shorts", "allowShorts") === true,
  });
}

/** Suffix marking `allow_shorts` on an exercise summary (also how enrichment re-detects it). */
const ALLOW_SHORTS_NOTE = " — may short shares to deliver";

function buildExerciseParsed(a: {
  cancel: boolean;
  legs: OptionLeg[];
  quantity: number | null;
  allowShorts: boolean;
}): ParsedOrder {
  const contract = a.legs[0]?.contract ?? null;
  const instrument = legsLabel(a.legs);
  const multiplier = contract?.multiplier ?? STANDARD_MULTIPLIER;
  // Cash needed to exercise a call: buy quantity × multiplier shares at the strike.
  const estCost =
    !a.cancel &&
    contract?.optionType === "call" &&
    contract.strikePrice != null &&
    a.quantity != null
      ? contract.strikePrice * multiplier * a.quantity
      : null;
  const size = a.quantity != null ? `${trimNum(a.quantity)} ` : "";
  const summary = a.cancel
    ? `Cancel exercise of ${instrument}`
    : `EXERCISE ${size}${instrument}${estCost != null ? ` — est. ${usd(estCost)} to buy shares` : ""}${
        a.allowShorts ? ALLOW_SHORTS_NOTE : ""
      }`;
  return {
    kind: a.cancel ? "cancel" : "exercise",
    symbol: up(contract?.chainSymbol ?? null),
    side: null,
    quantity: a.quantity,
    orderType: a.cancel ? "cancel" : "exercise",
    limitPrice: null,
    estCost,
    cancelsOrderId: null,
    summary,
    assetType: "option",
    instrument,
    legs: a.legs,
    multiplier,
    direction: null,
    stopPrice: null,
  };
}

/**
 * Fill in the contracts behind an option order's legs (from the broker's
 * `option_id` → contract map) and recompute everything that depends on them: the
 * underlying, the instrument label, the multiplier, the est. cost, the summary.
 * Covers placed orders and exercises/exercise-cancels (an ordinary order-cancel
 * has no legs and enriches from the ledger instead). Ids the map doesn't know
 * keep a null contract; a non-option order is untouched.
 */
export function enrichOptionParsed(
  parsed: ParsedOrder,
  contracts: Map<string, OptionContract>,
): ParsedOrder {
  if (parsed.assetType !== "option" || !parsed.legs?.length) return parsed;
  const legs = parsed.legs.map((l) => ({
    ...l,
    contract: contracts.get(l.optionId) ?? l.contract,
  }));
  if (parsed.kind === "exercise" || (parsed.kind === "cancel" && parsed.orderType === "cancel")) {
    if (parsed.kind === "cancel" && !parsed.summary.startsWith("Cancel exercise")) return parsed;
    return buildExerciseParsed({
      cancel: parsed.kind === "cancel",
      legs,
      quantity: parsed.quantity,
      // ParsedOrder carries no allow_shorts field; the parse-time summary does.
      allowShorts: parsed.summary.includes(ALLOW_SHORTS_NOTE),
    });
  }
  if (parsed.kind !== "place") return parsed;
  return {
    ...parsed,
    ...buildOptionParsed({
      legs,
      quantity: parsed.quantity,
      orderType: parsed.orderType,
      limitPrice: parsed.limitPrice,
      stopPrice: parsed.stopPrice ?? null,
      direction: parsed.direction ?? null,
      side: parsed.side,
    }),
  };
}

function buildOptionParsed(a: {
  legs: OptionLeg[];
  quantity: number | null;
  orderType: string | null;
  limitPrice: number | null;
  stopPrice: number | null;
  direction: string | null;
  side: string | null;
}): ParsedOrder {
  const known = a.legs.find((l) => l.contract);
  const multiplier = known?.contract?.multiplier ?? STANDARD_MULTIPLIER;
  const symbol = up(known?.contract?.chainSymbol ?? null);
  const instrument = legsLabel(a.legs);
  // Per-share limit × multiplier × contracts: the dollars the order actually moves
  // ($0.79 × 100 × 1 = $79). Only a priced order has an estimate.
  const priced = a.orderType === "limit" || a.orderType === "stop_limit";
  const estCost =
    priced && a.limitPrice != null && a.quantity != null
      ? a.limitPrice * multiplier * a.quantity
      : null;
  return {
    kind: "place",
    symbol,
    side: a.side,
    quantity: a.quantity,
    orderType: a.orderType,
    limitPrice: a.limitPrice,
    estCost,
    cancelsOrderId: null,
    summary: optionSummary({ ...a, instrument, estCost }),
    assetType: "option",
    instrument,
    legs: a.legs,
    multiplier,
    direction: a.direction,
    stopPrice: a.stopPrice,
  };
}

/**
 * `BUY 1 TLT $86C 11/20/26 to open @ $0.79 limit — est. $79.00`;
 * `DEBIT 2 TLT 2-leg spread @ $1.20 net limit — est. $240.00`;
 * `SELL 1 TLT $86C 11/20/26 to close @ market (stop $0.50)`.
 */
function optionSummary(a: {
  legs: OptionLeg[];
  quantity: number | null;
  orderType: string | null;
  limitPrice: number | null;
  stopPrice: number | null;
  side: string | null;
  instrument: string;
  estCost: number | null;
}): string {
  const verb = a.side ? a.side.toUpperCase() : "ORDER";
  const size = a.quantity != null ? `${trimNum(a.quantity)} ` : "";
  const effect =
    a.legs.length === 1 && a.legs[0].positionEffect ? ` to ${a.legs[0].positionEffect}` : "";
  const net = a.legs.length > 1 ? " net" : "";
  let price: string;
  switch (a.orderType) {
    case "limit":
      price = a.limitPrice != null ? `@ ${usd(a.limitPrice)}${net} limit` : "@ limit";
      break;
    case "stop_limit":
      price = `@ ${a.limitPrice != null ? usd(a.limitPrice) : "?"} stop-limit${stopClause(a.stopPrice)}`;
      break;
    case "stop_market":
      price = `@ market${stopClause(a.stopPrice)}`;
      break;
    default:
      price = "@ market";
  }
  const est = a.estCost != null ? ` — est. ${usd(a.estCost)}` : "";
  return `${verb} ${size}${a.instrument}${effect} ${price}${est}`.replace(/\s+/g, " ").trim();
}

function stopClause(stop: number | null): string {
  return stop != null ? ` (stop ${usd(stop)})` : "";
}

/**
 * The subset of a resolved ledger order we fold into a cancel's card. A cancel
 * tool call only carries the target order id, so on its own it reads as a bare
 * uuid ("Cancel order <uuid>"). Resolving that id against the broker's cached
 * ledger (which includes orders placed manually in the Robinhood app, not just
 * agent-placed ones) lets us render the real order — "Cancel BUY $5 of NET". For
 * an option order `instrument` names the contract (`TLT $86C 11/20/26`) and
 * `multiplier` scales the per-share limit into dollars.
 */
export interface CancelTarget {
  symbol: string | null;
  side: string | null;
  quantity: number | null;
  orderType: string | null;
  limitPrice: number | null;
  dollarAmount: number | null;
  assetType?: "equity" | "option" | "crypto";
  instrument?: string | null;
  multiplier?: number | null;
}

/**
 * Fold a resolved ledger order into a `cancel` ParsedOrder so its card shows what
 * is being cancelled instead of an opaque order id. A no-op for non-cancels or a
 * null target (the bare-uuid summary from `parseOrderInput` stands as the
 * fallback). `cancelsOrderId` is preserved — it's the link the Activity feed uses
 * to fold the cancel into the original order (for agent-placed orders).
 */
export function enrichCancelParsed(parsed: ParsedOrder, target: CancelTarget | null): ParsedOrder {
  if (parsed.kind !== "cancel" || !target) return parsed;
  const isOption = target.assetType === "option";
  const symbol = up(target.symbol);
  const side = low(target.side);
  const quantity = target.quantity && target.quantity > 0 ? target.quantity : null;
  const orderType = low(target.orderType);
  const limitPrice = target.limitPrice ?? null;
  const dollars = target.dollarAmount ?? null;
  const multiplier = isOption ? (target.multiplier ?? STANDARD_MULTIPLIER) : 1;
  const estCost =
    limitPrice != null && quantity != null ? limitPrice * multiplier * quantity : (dollars ?? null);
  const instrument = isOption ? (target.instrument ?? "option") : null;
  return {
    ...parsed,
    symbol: symbol ?? parsed.symbol,
    side,
    quantity,
    orderType: orderType ?? parsed.orderType,
    limitPrice,
    estCost,
    summary: cancelSummary({
      side,
      quantity,
      name: instrument ?? symbol,
      orderType,
      limitPrice,
      dollars,
    }),
    ...(isOption ? { assetType: "option" as const, instrument, multiplier } : {}),
  };
}

function cancelSummary(a: {
  side: string | null;
  quantity: number | null;
  /** What's being cancelled: the symbol, or an option's contract label. */
  name: string | null;
  orderType: string | null;
  limitPrice: number | null;
  dollars: number | null;
}): string {
  if (!a.name) return "Cancel order";
  const verb = a.side ? a.side.toUpperCase() : "";
  const size =
    a.quantity != null
      ? `${trimNum(a.quantity)} `
      : a.dollars != null
        ? `${usd(a.dollars)} of `
        : "";
  const price =
    a.orderType === "limit" && a.limitPrice != null ? ` @ ${usd(a.limitPrice)} limit` : "";
  return `Cancel ${verb} ${size}${a.name}${price}`.replace(/\s+/g, " ").trim();
}

function placeSummary(a: {
  side: string | null;
  quantity: number | null;
  symbol: string | null;
  orderType: string | null;
  limitPrice: number | null;
  stopPrice?: number | null;
  dollars: number | null;
  estCost: number | null;
}): string {
  const verb = a.side ? a.side.toUpperCase() : "ORDER";
  const size =
    a.quantity != null
      ? `${trimNum(a.quantity)} `
      : a.dollars != null
        ? `${usd(a.dollars)} of `
        : "";
  const sym = a.symbol ?? "?";
  let price: string;
  switch (a.orderType) {
    case "limit":
      price = a.limitPrice != null ? `@ ${usd(a.limitPrice)} limit` : "@ limit";
      break;
    case "stop_limit":
      price = `@ ${a.limitPrice != null ? usd(a.limitPrice) : "?"} stop-limit${stopClause(a.stopPrice ?? null)}`;
      break;
    // Crypto names the stop-triggered market order `stop_loss`; equities `stop_market`.
    case "stop_loss":
    case "stop_market":
      price = `@ market${stopClause(a.stopPrice ?? null)}`;
      break;
    default:
      price = "@ market";
  }
  const est = a.estCost != null && a.quantity != null ? ` — est. ${usd(a.estCost)}` : "";
  return `${verb} ${size}${sym} ${price}${est}`.replace(/\s+/g, " ").trim();
}

/** A limit_price present without an explicit type strongly implies a limit order. */
function inferType(o: Record<string, unknown>): string | null {
  if (pick(o, "limit_price", "limitPrice") != null) return "limit";
  return null;
}

/**
 * Best-effort classification of an order tool's *result* (from PostToolUse). Its
 * only lasting job now is to capture the **orderId** (the link to RH's
 * authoritative ledger) and the submit-time reject case RH never records as an
 * order (e.g. "market orders not allowed in extended hours" → `ok:false` + a
 * human `message`, no order created). Execution status itself is read live from
 * `get_equity_orders`, not inferred here. `ok:null` means unclassifiable.
 */
export function parseOrderResult(result: unknown, toolName?: string): OrderOutcome {
  const at = Date.now();
  const { text, isError, obj } = unwrapResult(result);
  const structured = obj ?? tryParse(text);

  // Cancels are a different shape: RH returns `{ data: { accepted: true } }` — the
  // broker *accepted* the cancel request (cancellation is async), plus a `guide`
  // string. Classify on that flag, not the place-order error heuristic below: the
  // guide enumerates states like "rejected"/"failed" and would otherwise trip the
  // error-word match and mislabel a successful cancel as a broker rejection.
  if (toolName && /cancel_/.test(toolName)) {
    const data = (pick(structured ?? {}, "data") ?? structured ?? {}) as Record<string, unknown>;
    const accepted = boolish(pick(data, "accepted"));
    let ok: boolean | null;
    if (isError || accepted === false) ok = false;
    else if (accepted === true) ok = true;
    else ok = null;
    const message =
      accepted === true
        ? "Broker accepted the cancel request (cancellation is asynchronous)"
        : extractMessage(text, structured);
    return { ok, orderId: null, message, at };
  }

  const orderId =
    str(pick(structured ?? {}, "order_id", "id", "orderId", "order_number")) ?? findUuid(text);
  const state = low(str(pick(structured ?? {}, "state", "status", "order_state")));

  const rejectedState = state ? /reject|cancel|fail|denied/.test(state) : false;
  const acceptedState = state
    ? /queued|confirmed|unconfirmed|filled|partial|pending|accepted|new|open/.test(state)
    : false;
  const errorWords = /\b(error|not allowed|invalid|insufficient|cannot|denied|failed|reject)\b/i;

  let ok: boolean | null;
  if (isError || rejectedState) ok = false;
  else if (orderId || acceptedState) ok = true;
  else if (errorWords.test(text)) ok = false;
  else ok = null;

  return { ok, orderId, message: extractMessage(text, structured), at };
}

function unwrapResult(result: unknown): {
  text: string;
  isError: boolean;
  obj: Record<string, unknown> | null;
} {
  if (result === null || result === undefined) return { text: "", isError: false, obj: null };
  if (typeof result === "string") return { text: result, isError: false, obj: tryParse(result) };
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    const isError = r.isError === true || r.is_error === true;
    if (Array.isArray(r.content)) {
      const text = r.content
        .map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).text) : null))
        .filter((t): t is string => Boolean(t))
        .join("\n");
      return { text: text || JSON.stringify(r), isError, obj: tryParse(text) };
    }
    return { text: JSON.stringify(r), isError, obj: r };
  }
  return { text: String(result), isError: false, obj: null };
}

function extractMessage(text: string, obj: Record<string, unknown> | null): string | null {
  const fromObj = obj
    ? str(pick(obj, "error", "message", "detail", "reason", "error_message", "errors"))
    : null;
  const t = (fromObj ?? text ?? "").trim();
  if (!t) return null;
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

function tryParse(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findUuid(text: string): string | null {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}
function boolish(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
function up(v: string | null): string | null {
  return v ? v.toUpperCase() : null;
}
function low(v: string | null): string | null {
  return v ? v.toLowerCase() : null;
}
function numv(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
