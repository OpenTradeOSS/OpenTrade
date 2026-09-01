import type {
  Account,
  CryptoPosition,
  CryptoQuote,
  OptionContract,
  OptionPosition,
  OptionQuote,
  OrderStatus,
  Portfolio,
  Position,
  Quote,
} from "@shared/broker";

/** MCP server entry the app writes into agents' .mcp.json. */
export interface McpServerConfig {
  type: "http";
  url: string;
}

/**
 * Thrown to a pending interactive connect when a newer one takes over (the user
 * clicked Connect again, most likely after abandoning the browser consent). Not a
 * broker failure: the service neither reports it nor touches the connection status.
 */
export class ConnectSuperseded extends Error {
  constructor() {
    super("connect superseded by a newer connect");
    this.name = "ConnectSuperseded";
  }
}

/**
 * A trading execution + read backend. v1 implements Robinhood only, but the read
 * panel, poller, and faucet all speak this interface so a second broker (e.g.
 * Alpaca) slots in later.
 */
export interface BrokerAdapter {
  readonly id: string;
  /**
   * Connect. A cached, still-valid session always connects silently. `interactive`
   * governs only the recovery path when the stored session is dead (expired/revoked
   * grant): `true` (the explicit Connect action) opens a browser for re-consent;
   * `false`/omitted (the silent boot auto-connect) just drops the dead tokens and
   * stays disconnected — never pops a browser unprompted.
   */
  connect(opts?: { interactive?: boolean }): Promise<void>;
  /**
   * Abandon an interactive connect waiting on the user (browser consent): its pending
   * `connect()` rejects with `ConnectSuperseded`. No-op when nothing is pending.
   */
  cancelConnect?(): void;
  /**
   * Forget the session: abandon any pending consent, drop stored tokens + client
   * registration, close the live connection. The next `connect({interactive})` is a
   * fresh consent. Backs the user's Reset/Disconnect action.
   */
  reset(): void;
  isConnected(): boolean;
  listAccounts(): Promise<Account[]>;
  getPortfolio(accountNumber: string): Promise<Portfolio>;
  getPositions(accountNumber: string): Promise<Position[]>;
  /**
   * The agentic order ledger (orders this app's agents placed) — the source of
   * truth for execution status. `createdAtGte`/`cursor` bound + paginate it.
   */
  getAgenticOrders(
    accountNumber: string,
    opts?: { createdAtGte?: string; cursor?: string },
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }>;
  /** Single-order lookup by id (resolves orders aged out of the ledger window). */
  getOrder(accountNumber: string, orderId: string): Promise<OrderStatus | null>;
  getQuotes(symbols: string[]): Promise<Quote[]>;

  // ---- options (optional: a broker without an options API simply has none) ----

  /** The option order ledger, same contract as `getAgenticOrders`. */
  getOptionOrders?(
    accountNumber: string,
    opts?: { createdAtGte?: string; cursor?: string },
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }>;
  getOptionOrder?(accountNumber: string, orderId: string): Promise<OrderStatus | null>;
  /** Open (non-zero) option positions. */
  getOptionPositions?(accountNumber: string): Promise<OptionPosition[]>;
  /** Resolve contract ids to their identity (underlying / expiry / strike / type). */
  getOptionContracts?(optionIds: string[]): Promise<OptionContract[]>;
  getOptionQuotes?(optionIds: string[]): Promise<OptionQuote[]>;

  // ---- crypto (optional, same convention; keyed by the numeric rhs account) ----

  getCryptoOrders?(
    rhsAccountNumber: string,
    opts?: { createdAtGte?: string; cursor?: string },
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }>;
  getCryptoOrder?(rhsAccountNumber: string, orderId: string): Promise<OrderStatus | null>;
  getCryptoPositions?(rhsAccountNumber: string): Promise<CryptoPosition[]>;
  /** Quotes by pair symbol ("BTC-USD"); results come back unhyphenated ("BTCUSD"). */
  getCryptoQuotes?(pairSymbols: string[]): Promise<CryptoQuote[]>;
  /** What to write into an agent's .mcp.json. */
  mcpServerConfig(): { name: string; config: McpServerConfig };
}
