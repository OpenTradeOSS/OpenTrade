import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { errorCodeOf } from "@shared/analytics";

/** "The network is not there right now" — DNS, connect/reset/timeout, unreachable, undici's own. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * MCP-layer failures that mean the same thing as a network drop: the poll's request
 * never came back. These fire one stage *later* than a connect-time `fetch failed` — the
 * POST had already connected, then the machine froze (laptop sleep interrupting a poll),
 * so the SDK's 60 s timer (`RequestTimeout`) fires or the stream is seen closed
 * (`ConnectionClosed`). A genuine server-side JSON-RPC error (`InvalidParams`,
 * `InternalError`, …) is NOT here — it stays an `app_error`.
 */
const TRANSIENT_MCP_CODES = new Set<number>([ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]);

/**
 * Is this failure a transient network outage — what a laptop produces around
 * sleep/wake, a Wi‑Fi handoff, a VPN flap — as opposed to a bug, a protocol error, or
 * the server rejecting us? True for a transport-level code (on the error or, as undici
 * does it, on its `cause`), the two transient MCP codes above, and a bare
 * `TypeError: fetch failed` whose cause we don't recognize (still transport-level, never
 * app logic; nothing in our bundle produces that message). Anything else — a mapping
 * TypeError from our code, a server-side `McpError`, an HTTP error class — is not
 * transient and stays an `app_error`.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof McpError && TRANSIENT_MCP_CODES.has(err.code)) return true;
  const code = errorCodeOf(err);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && err.message === "fetch failed";
}

/**
 * Has the authorization server rejected our refresh token for good? `invalid_grant` is
 * the one auth failure that is *never* worth retrying: the grant is expired or revoked,
 * and no amount of waiting brings it back — only a fresh consent does.
 *
 * Deliberately narrower than `isReauthRequired` (`robinhood/client.ts`), which also
 * counts a resource `UnauthorizedError`. That breadth is right when deciding whether to
 * start a consent the user just asked for; it is wrong on the poll path, where a
 * transient or endpoint-specific 401 would throw away credentials that still work.
 */
export function isDeadGrantError(err: unknown): boolean {
  return err instanceof InvalidGrantError;
}

/**
 * The bounded telemetry code for a broker error: `errorCodeOf` (err.code / err.cause.code)
 * for the transport cases, plus the MCP layer — an `McpError`'s `code` is a *number*
 * (`-32001`), which the allowlist regex drops, so map it to its enum **name**
 * (`RequestTimeout`, `ConnectionClosed`, …), a bare identifier. Unknown numeric codes
 * (a server's own) have no enum name → undefined, correctly dropped. This keeps MCP
 * knowledge in the broker layer; `errorCodeOf` in shared/ stays SDK-agnostic.
 */
export function brokerErrorCode(err: unknown): string | undefined {
  if (err instanceof McpError) return ErrorCode[err.code];
  return errorCodeOf(err);
}
