#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { homedir } = require("node:os");
const { join } = require("node:path");

const [kind, agentId = process.env.OPENTRADE_AGENT_ID || "", homeArg = ""] = process.argv.slice(2);
const routes = {
  approval: { path: "/hook/pretool-approval", timeout: 360_000 },
  "order-result": { path: "/hook/order-result", timeout: 5_000 },
  status: { path: "/hook/status", timeout: 5_000 },
};
const route = routes[kind];

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

function endpoint() {
  if (process.env.OPENTRADE_PORT && process.env.OPENTRADE_TOKEN) {
    return { port: Number(process.env.OPENTRADE_PORT), token: process.env.OPENTRADE_TOKEN };
  }
  const home = homeArg || process.env.OPENTRADE_HOME || join(homedir(), ".opentrade");
  try {
    const manifest = JSON.parse(readFileSync(join(home, "host.json"), "utf8"));
    return { port: Number(manifest.faucetPort), token: String(manifest.token || "") };
  } catch {
    return { port: 0, token: "" };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!route) return;
  const input = await readStdin();
  const { port, token } = endpoint();
  if (!port || !token) {
    if (kind === "approval") {
      deny(
        "OpenTrade is not running (no local endpoint); the approval gate fails closed. Open OpenTrade, then retry.",
      );
    }
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      if (kind === "approval") {
        if (response) process.stdout.write(`${response}\n`);
        else deny("OpenTrade did not respond; the approval gate fails closed. Do not retry until the user confirms OpenTrade is running.");
      }
      resolve();
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route.path,
        method: "POST",
        headers: {
          "x-opentrade-token": token,
          "x-opentrade-agent": agentId,
          "content-type": "application/json",
          "content-length": input.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => finish(Buffer.concat(chunks).toString("utf8").trim()));
      },
    );
    req.setTimeout(route.timeout, () => req.destroy(new Error("hook request timed out")));
    req.on("error", () => finish(""));
    req.end(input);
  });
}

main().catch(() => {
  if (kind === "approval") deny("OpenTrade hook failed; the approval gate fails closed.");
});
