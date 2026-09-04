<div align="center">
  <img src="assets/logo.svg" width="360" alt="OpenTrade" />
  <p><strong>The open-source trading harness for Claude Code / Codex agents.</strong></p>

  <p>
    <a href="https://github.com/OpenTradeOSS/OpenTrade/stargazers"><img src="https://img.shields.io/github/stars/OpenTradeOSS/OpenTrade?style=flat&logo=github" alt="GitHub stars" /></a>
    <a href="https://github.com/OpenTradeOSS/OpenTrade/releases"><img src="https://img.shields.io/github/v/release/OpenTradeOSS/OpenTrade?style=flat&logo=github" alt="Latest release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Elastic%20License%202.0-blue?style=flat" alt="License" /></a>
    <a href="https://discord.gg/F63YFPRtq"><img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord" /></a>
  </p>

  <p>
    <a href="https://www.producthunt.com/products/opentrade?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-opentrade" target="_blank" rel="noopener noreferrer"><img alt="OpenTrade - Open-source trading harness for Claude Code / Codex. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1223212&amp;theme=light&amp;t=1787349340884"></a>
  </p>

  <img src="assets/demo.png" width="820" alt="OpenTrade app — agent sidebar, live terminal, and portfolio panel" />
</div>

OpenTrade is a macOS and Windows app that enables agents to trade and react to the market autonomously. Agents execute trades in your [Robinhood Agentic Trading](https://robinhood.com/us/en/agentic-trading/) account through the official MCP. Set guardrails, monitors, and schedules so agents can trade 24/7 - all on your machine.

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Monitor real-time events

Agents can schedule themselves periodically or on arbitrary events via background scripts.

</td>
<td width="50%">
  <img src="assets/readme/monitor-events.jpg" alt="The Monitor tab listing an agent's active timers and event monitors, including the shell command that wakes it on a new RSS post" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orchestrate multiple agents

Delegate strategies and your portfolio to any number of agents.

</td>
<td width="50%">
  <img src="assets/readme/orchestrate-agents.jpg" alt="The agent sidebar with nine agents, each running its own strategy, next to the selected agent's terminal" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Trading guardrails

Manual/auto order approvals, background turn limits for agents, and per-agent order accounting.

</td>
<td width="50%">
  <img src="assets/readme/guardrails.jpg" alt="A pending buy order awaiting approval, above a history of past decisions and an order that expired undecided" width="100%" />
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Background sessions

Agents continue to get notified and work in the background, even if the app is closed.

</td>
<td width="50%">
  <img src="assets/readme/background-sessions.jpg" alt="The OpenTrade menu bar tray reporting three of nine agents working, with each agent's status listed" width="100%" />
</td>
</tr>
</table>

## Install

Download the latest installer from [Releases](https://github.com/OpenTradeOSS/OpenTrade/releases):

- macOS (Apple Silicon): `OpenTrade-<version>-arm64.dmg`; open it and drag OpenTrade to Applications.
- Windows 10/11 (x64): `OpenTrade-<version>-x64-setup.exe`.

The app auto-updates from GitHub Releases on both platforms.

OpenTrade supports both Claude Code and Codex agents, so please install and sign into `claude`
and/or `codex` CLI. An authenticated MCP connection to Robinhood via your agent is required, see
the [Robinhood MCP](https://robinhood.com/us/en/support/articles/agentic-trading-overview/#ConnectyourAIagent)
instructions.

## Build from source

```bash
bun install           # from repo root (bun workspaces)
bun run dev           # rebuild native modules for Electron, then launch with HMR
```

The same commands work in PowerShell on Windows. To create a local Windows installer:

```powershell
bun run --cwd app package -- --win --x64 --publish never
```

## Contributing

Contributions are welcome — bug reports, fixes, and features alike. Open a pull request and
we'll take a look.

## Community

Come join our [Discord](https://discord.gg/F63YFPRtq) to discuss all things OpenTrade!

## Disclaimer

OpenTrade is experimental software provided **as-is and without warranty of any kind**.
It is **not financial, investment, or trading advice**. The software runs autonomous
agents that can place and cancel real orders against a funded brokerage account; **you
are solely responsible for configuring, supervising, and bearing the financial
consequences of your agents.** Trading involves substantial risk of loss.

OpenTrade is built by Exla Corp. It is **not affiliated with, endorsed by,
or sponsored by Robinhood Markets, Inc., Anthropic, or OpenAI.** "Robinhood," "Claude,"
"Claude Code," and "Codex" are trademarks of their respective owners. You are responsible
for complying with the terms of service of any broker or API you connect to.

## License

[Elastic License 2.0](LICENSE) — source-available. You may use, copy, modify, and
redistribute the software, but you may not provide it to third parties as a hosted or
managed service. See [LICENSE](LICENSE) and third-party attributions in [NOTICE](NOTICE).
