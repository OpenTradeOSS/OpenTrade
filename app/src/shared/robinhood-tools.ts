/**
 * The single source of truth for how Robinhood MCP tools are gated. Both harness
 * configs derive from this table — claude's `.claude/settings.json` (PreToolUse/
 * PostToolUse matcher + permissions allowlist, `harness/claude.ts`) and codex's
 * `config.toml` per-tool approval modes + `hooks.json` matcher (`harness/codex.ts`).
 * Before this module the same list was hand-copied in three places and rotted:
 * Robinhood shipped `place_option_order` and later `place_crypto_order`, and orders
 * ran ungated until someone noticed.
 *
 * LAST_VERIFIED is when a human last diffed this table against the live server's
 * tool list (connect an MCP client to https://agent.robinhood.com/mcp/trading and
 * list tools). When Robinhood ships new tools, classify each one here:
 *  - moves money (place/cancel/exercise anything) → MONEY_MOVERS (gated);
 *  - writes state but can't move money (watchlists, scans) → COSMETIC_WRITES
 *    (pre-allowed);
 *  - read-only or a pure simulation → covered by READ_PATTERNS, or add the name.
 * Policy (Pranav, 2026-08-31): gate money-movers only; tools this table doesn't
 * know are NOT gated — which is exactly why it must be kept current.
 */
export const LAST_VERIFIED = "2026-08-31";

/**
 * Tools that move real money (or irreversibly commit it — an exercise past
 * `queued` cannot be recalled). Every name here is gated behind the human
 * approval card in both harnesses.
 */
export const MONEY_MOVERS = [
  "place_equity_order",
  "cancel_equity_order",
  "place_option_order",
  "cancel_option_order",
  "place_crypto_order",
  "cancel_crypto_order",
  "exercise_option",
  "cancel_option_exercise",
] as const;

/**
 * Writes that cannot move money — watchlist and scanner bookkeeping. Pre-allowed
 * so agents don't raise Claude Code's generic permission prompt for cosmetics
 * (codex pre-approves them via the server-level default already).
 */
export const COSMETIC_WRITES = [
  "add_to_watchlist",
  "remove_from_watchlist",
  "add_option_to_watchlist",
  "remove_option_from_watchlist",
  "create_watchlist",
  "update_watchlist",
  "follow_watchlist",
  "unfollow_watchlist",
  "create_scan",
  "update_scan_config",
  "update_scan_filters",
] as const;

/**
 * Read-only tool name patterns (Claude Code permission-rule wildcards, not
 * regexes): every `get_*`, the resolvers/screeners, and the order *simulations*
 * (`review_*` / `preview_*` price an order without placing it).
 */
export const READ_PATTERNS = ["get_*", "search", "run_scan", "review_*", "preview_*"] as const;

/** MCP prefix Claude Code exposes the server's tools under (server name "robinhood"). */
const PREFIX = "mcp__robinhood__";

/**
 * The gate matcher for both harnesses' hooks configs: an alternation of the
 * exact money-mover names — deliberately no open-ended wildcard, so an unknown
 * future tool is NOT gated (see the policy note above).
 */
export const GATED_TOOL_MATCHER = `${PREFIX}(${MONEY_MOVERS.join("|")})`;

/** Bare gated names, for codex's per-tool `[mcp_servers.robinhood.tools.<t>]` TOML. */
export const GATED_TOOLS: readonly string[] = MONEY_MOVERS;

/** Claude `permissions.allow` entries for everything that is not a money-mover. */
export const PREALLOWED_TOOL_PATTERNS: readonly string[] = [
  ...READ_PATTERNS.map((p) => `${PREFIX}${p}`),
  ...COSMETIC_WRITES.map((t) => `${PREFIX}${t}`),
];
