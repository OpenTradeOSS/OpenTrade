/**
 * The gateway's own pages (sign-in, account, workspace starting). Server-rendered and
 * dependency-free; the app itself is the renderer's web build.
 */
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

const STYLE = `
:root{--bg:#05060a;--panel:#0d0f16;--line:#1c2030;--text:#e7e9f0;--muted:#8a90a6;--accent:#4ade80;--accent-ink:#04110a;--danger:#f87171}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:880px;margin:0 auto;padding:32px 16px 64px}
.narrow{max-width:400px;margin:10vh auto 0;padding:0 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:17px;margin-bottom:28px}
.brand img{width:28px;height:28px;border-radius:7px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:16px;margin:0 0 12px}
p.muted,.muted{color:var(--muted)}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#07080d;color:var(--text);font:inherit}
input:focus{outline:2px solid #4ade8055;border-color:var(--accent)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 16px;border-radius:9px;border:1px solid var(--line);background:#141826;color:var(--text);font:inherit;font-weight:500;cursor:pointer}
button.primary,.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button.danger{background:transparent;color:var(--danger);border-color:#f8717155}
button:disabled{opacity:.5;cursor:default}
.full{width:100%;margin-top:18px}
.err{color:var(--danger);font-size:14px;min-height:20px;margin-top:10px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.plan{border:1px solid var(--line);border-radius:12px;padding:16px}
.plan.current{border-color:var(--accent)}
.big{font-size:28px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 4px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#4ade8022;color:var(--accent)}
.spinner{width:28px;height:28px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;margin:24px auto}
@keyframes s{to{transform:rotate(360deg)}}
`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/icon-192.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#05060a">
<style>${STYLE}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const BRAND = `<div class="brand"><img src="/icon-192.png" alt="">OpenTrade</div>`;

const POST_JSON = `
async function postJSON(url, body, method) {
  const res = await fetch(url, { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong.");
  return json;
}`;

export function authPage(mode: "login" | "signup"): string {
  const isSignup = mode === "signup";
  return page(
    isSignup ? "Create your account · OpenTrade" : "Sign in · OpenTrade",
    `<div class="narrow">${BRAND}
<div class="card">
<h1>${isSignup ? "Create your account" : "Sign in"}</h1>
<p class="muted">${isSignup ? "Your own cloud workspace for trading agents. Free for two agents, every order waits for your approval." : "Welcome back."}</p>
<form id="f">
<label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="${isSignup ? 10 : 1}" required>
<button class="primary full" id="go" type="submit">${isSignup ? "Create account" : "Sign in"}</button>
<div class="err" id="err"></div>
</form>
${isSignup ? `<p class="muted" style="font-size:13px">By creating an account you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>. OpenTrade is software, not a broker or adviser; you approve every order.</p>` : ""}
</div>
<p class="muted" style="text-align:center">${isSignup ? `Already have an account? <a href="/login">Sign in</a>` : `New to OpenTrade? <a href="/signup">Create an account</a>`}</p>
</div>`,
    `${POST_JSON}
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = document.getElementById("go"); go.disabled = true;
  document.getElementById("err").textContent = "";
  try {
    await postJSON("/api/auth/${mode}", { email: email.value, password: password.value });
    location.href = "/";
  } catch (err) { document.getElementById("err").textContent = err.message; go.disabled = false; }
});`,
  );
}

export function startingPage(error: string | null): string {
  return page(
    "Starting your workspace · OpenTrade",
    `<div class="narrow">${BRAND}<div class="card" style="text-align:center">
${
  error
    ? `<h1>Your workspace didn't start</h1><p class="muted">${esc(error)}</p><button class="primary" id="retry">Try again</button>`
    : `<h1>Starting your workspace</h1><p class="muted">Setting up a private sandbox for your agents. This takes under a minute the first time.</p><div class="spinner"></div>`
}
</div></div>`,
    error
      ? `${POST_JSON} document.getElementById("retry").onclick = async () => { await postJSON("/api/sandbox/retry"); location.reload(); };`
      : `setInterval(async () => { const r = await fetch("/api/me"); const j = await r.json(); if (j.sandbox && j.sandbox.status !== "creating") location.reload(); }, 2000);`,
  );
}

export function accountPage(): string {
  return page(
    "Account · OpenTrade",
    `<div class="wrap">
<div class="row" style="margin-bottom:20px"><div class="brand" style="margin:0"><img src="/icon-192.png" alt="">OpenTrade</div>
<div class="row"><a class="btn" href="/">Open OpenTrade</a><button id="logout">Sign out</button></div></div>
<div id="banner"></div>
<div class="card"><div class="row"><div><div class="muted">Signed in as</div><div id="email" style="font-weight:600"></div></div>
<div style="text-align:right"><div class="muted">Credits</div><div class="big" id="credits">–</div><div class="muted" style="font-size:12px">1 credit = $0.01 of model usage</div></div></div></div>
<div class="card"><h2>Plan</h2><div class="grid" id="plans"></div>
<div class="row" style="margin-top:14px"><span class="muted">Need more? Credit packs never expire.</span><div class="row" id="packs"></div></div>
<div style="margin-top:12px"><button id="portal" style="display:none">Manage billing</button></div></div>
<div class="card"><h2>Your own API keys <span class="pill">optional</span></h2>
<p class="muted">With your own key, agents bill your provider account directly and use no credits. Keys are encrypted and never shown again.</p>
<label for="anth">Anthropic API key (Claude)</label><div class="row" style="flex-wrap:nowrap"><input id="anth" type="password" placeholder="sk-ant-…" autocomplete="off"><button id="saveAnth">Save</button><button id="clearAnth" class="danger">Remove</button></div><div class="muted" id="anthState" style="font-size:13px;margin-top:4px"></div>
<label for="oai">OpenAI API key (Codex)</label><div class="row" style="flex-wrap:nowrap"><input id="oai" type="password" placeholder="sk-…" autocomplete="off"><button id="saveOai">Save</button><button id="clearOai" class="danger">Remove</button></div><div class="muted" id="oaiState" style="font-size:13px;margin-top:4px"></div>
<div class="err" id="keyErr"></div></div>
<div class="card"><h2>Usage, last 30 days</h2><table><thead><tr><th>Agent</th><th>Model</th><th>Tokens</th><th>Credits</th></tr></thead><tbody id="usage"></tbody></table></div>
<div class="card"><h2>Delete account</h2><p class="muted">Stops your agents, deletes your workspace and all its data, and cancels your subscription. This can't be undone.</p>
<button class="danger" id="del">Delete my account</button></div>
</div>`,
    `${POST_JSON}
const fmt = (n) => Math.floor(n).toLocaleString();
async function load() {
  const me = await (await fetch("/api/me")).json();
  if (!me.user) { location.href = "/login"; return; }
  email.textContent = me.user.email;
  credits.textContent = fmt(me.credits);
  const q = new URLSearchParams(location.search).get("checkout");
  if (q === "success") banner.innerHTML = '<div class="card" style="border-color:var(--accent)">Payment received, thank you. Credits appear here within a few seconds.</div>';
  plans.innerHTML = me.plans.map((p) => '<div class="plan ' + (p.id === me.user.plan ? "current" : "") + '"><div class="row"><b>' + p.name + '</b>' + (p.id === me.user.plan ? '<span class="pill">Current</span>' : "") + '</div><div class="big">$' + p.priceUsd + '<span class="muted" style="font-size:14px">/mo</span></div><div class="muted">' + (p.monthlyCredits ? fmt(p.monthlyCredits) + " credits / month" : "Bring your own key") + '<br>Up to ' + p.maxAgents + ' agents</div>' + (p.id !== me.user.plan && p.priceUsd > 0 ? '<button class="primary full" data-buy="' + p.id + '">Choose ' + p.name + '</button>' : "") + '</div>').join("");
  packs.innerHTML = me.packs.map((p) => '<button data-buy="' + p.id + '">' + fmt(p.credits) + ' credits · $' + p.priceUsd + '</button>').join("");
  portal.style.display = me.user.hasSubscription ? "" : "none";
  anthState.textContent = me.user.byok.anthropic ? "Using your key: " + me.user.byok.anthropic : "Using OpenTrade credits.";
  oaiState.textContent = me.user.byok.openai ? "Using your key: " + me.user.byok.openai : "Using OpenTrade credits.";
  usage.innerHTML = me.usage.length ? me.usage.map((u) => '<tr><td>' + (u.agentName || u.agentId || "—") + '</td><td>' + u.model + '</td><td>' + fmt(u.tokens) + '</td><td>' + (u.byok ? "your key" : fmt(u.credits)) + '</td></tr>').join("") : '<tr><td colspan="4" class="muted">No usage yet.</td></tr>';
  document.querySelectorAll("[data-buy]").forEach((b) => b.onclick = async () => { b.disabled = true; try { const r = await postJSON("/api/billing/checkout", { item: b.dataset.buy }); location.href = r.url; } catch (e) { alert(e.message); b.disabled = false; } });
}
logout.onclick = async () => { await postJSON("/api/auth/logout"); location.href = "/login"; };
portal.onclick = async () => { const r = await postJSON("/api/billing/portal"); location.href = r.url; };
async function saveKey(provider, input) { keyErr.textContent = ""; try { await postJSON("/api/keys", { provider, key: input ? input.value : null }); if (input) input.value = ""; load(); } catch (e) { keyErr.textContent = e.message; } }
saveAnth.onclick = () => saveKey("anthropic", anth); clearAnth.onclick = () => saveKey("anthropic", null);
saveOai.onclick = () => saveKey("openai", oai); clearOai.onclick = () => saveKey("openai", null);
del.onclick = async () => { const typed = prompt('Type DELETE to permanently delete your account and workspace.'); if (typed !== "DELETE") return; await postJSON("/api/account", {}, "DELETE"); location.href = "/signup"; };
load();`,
  );
}

export function finishPage(): string {
  return page(
    "Finish signing in · OpenTrade",
    `<div class="narrow">${BRAND}<div class="card">
<h1>Finish a sign-in</h1>
<p class="muted">When an agent's terminal asks you to log in to a service (for example Robinhood in Claude Code), your browser ends on a page that won't load, with an address starting <code>http://localhost</code>. Copy that whole address and paste it here.</p>
<label for="u">Address from your browser</label><input id="u" placeholder="http://localhost:…/callback?code=…" autocomplete="off">
<button class="primary full" id="go">Finish sign-in</button><div class="err" id="err"></div>
<p class="muted" id="ok" style="display:none">Done. Return to the agent's terminal.</p>
</div><p class="muted" style="text-align:center"><a href="/">Back to OpenTrade</a></p></div>`,
    `${POST_JSON}
go.onclick = async () => { err.textContent = ""; go.disabled = true; try { await postJSON("/api/oauth/finish", { url: u.value }); ok.style.display = ""; } catch (e) { err.textContent = e.message; } go.disabled = false; };`,
  );
}
