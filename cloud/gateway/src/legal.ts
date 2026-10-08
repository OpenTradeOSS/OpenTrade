/**
 * Privacy policy, terms and support for OpenTrade Cloud and the iPhone app (the App
 * Store requires a reachable privacy policy and support page). Plain language; reviewed
 * versions should replace these before general availability.
 */
const UPDATED = "October 8, 2026";

function doc(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · OpenTrade</title><link rel="icon" href="/icon-192.png">
<style>
:root{color-scheme:dark}body{margin:0;background:#05060a;color:#e7e9f0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 80px}h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px}
p,li{color:#c9ccd8}.muted{color:#8a90a6}a{color:#4ade80}ul{padding-left:20px}
</style></head><body><main><p><a href="/">OpenTrade</a></p><h1>${title}</h1><p class="muted">Last updated ${UPDATED}</p>${body}</main></body></html>`;
}

export const privacyPage = () =>
  doc(
    "Privacy Policy",
    `
<p>This policy covers OpenTrade Cloud (the hosted OpenTrade service) and the OpenTrade iPhone app, operated by Exla Corp ("we"). The open-source OpenTrade desktop app runs on your computer and sends us nothing except optional, anonymous product analytics you can turn off.</p>
<h2>What we collect</h2>
<ul>
<li><b>Account:</b> your email address and a salted hash of your password. We never store your password itself.</li>
<li><b>Your workspace:</b> each account gets a private, isolated cloud workspace that holds your agents, their instructions, schedules, conversation history, the orders they propose and your decisions. It also holds connection tokens for brokers or exchanges you connect (for example Robinhood). These are stored to run your agents and are not used for anything else.</li>
<li><b>Model usage:</b> your agents send prompts to AI model providers (Anthropic, OpenAI) through our gateway. We record the number of tokens and the cost of each request to bill credits; we do not store the prompts or responses at the gateway.</li>
<li><b>Your own API keys</b>, if you add them, encrypted at rest.</li>
<li><b>Payments</b> are handled by Stripe. We receive your Stripe customer ID and subscription status, never your card number.</li>
<li><b>Notifications:</b> if you turn them on, a push token for your device, used only to tell you when an order needs your approval.</li>
</ul>
<h2>How we use it</h2>
<p>To run your agents, ask for your approval on orders, bill your plan and credits, keep the service secure and answer your support requests. We don't sell your data and we don't use it for advertising. We don't use your workspace contents to train models.</p>
<h2>Who we share it with</h2>
<p>Only the processors needed to run the service: Fly.io (hosting), Anthropic and OpenAI (model requests your agents make), Stripe (payments), Expo and Apple (push notifications), and the brokers or exchanges you choose to connect, which receive the orders you approve.</p>
<h2>Retention and deletion</h2>
<p>Your data is kept while your account is open. You can delete your account at any time from the Account page on the web or in the iPhone app. Deletion stops your agents and permanently deletes your workspace, its volume and your account record; billing records Stripe must keep for tax purposes are retained by Stripe.</p>
<h2>Security</h2>
<p>Each workspace runs in its own isolated machine on a private network, reachable only through our gateway. Secrets are encrypted at rest. Every order an agent proposes waits for your approval unless you choose otherwise for that agent.</p>
<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:support@opentrade.bot">support@opentrade.bot</a>.</p>`,
  );

export const termsPage = () =>
  doc(
    "Terms of Service",
    `
<p>These terms govern your use of OpenTrade Cloud and the OpenTrade iPhone app, provided by Exla Corp. By creating an account you agree to them.</p>
<h2>What OpenTrade is</h2>
<p>OpenTrade is software that runs AI agents you configure and lets you review and approve the orders they propose. <b>OpenTrade is not a broker-dealer, investment adviser or exchange, and nothing in the service is investment advice.</b> Orders are placed with brokers or exchanges you connect, under your own account with them and subject to their terms.</p>
<h2>Your responsibility</h2>
<ul>
<li>You decide what your agents do and which orders to approve. Trading involves risk, including loss of your entire investment. AI agents make mistakes.</li>
<li>You must be legally allowed to trade the instruments you trade, in your jurisdiction, with the venues you connect.</li>
<li>Keep your account credentials secure. You're responsible for activity in your account.</li>
<li>Don't use the service to break the law, to manipulate markets, or to attack or overload the service or others.</li>
</ul>
<h2>Plans, credits and billing</h2>
<p>Paid plans renew monthly until cancelled and include a monthly credit allowance. Credits pay for model usage at the published rate; plan credits are granted each billing period and purchased credit packs don't expire. You can cancel at any time; access continues to the end of the paid period. Prices may change with notice.</p>
<h2>Availability</h2>
<p>We work to keep the service running but don't guarantee it will be uninterrupted. An outage can delay or prevent an agent from acting or an approval from reaching you. Don't rely on OpenTrade as your only way to manage positions.</p>
<h2>Liability</h2>
<p>To the extent the law allows, the service is provided "as is", and Exla Corp is not liable for trading losses, lost profits, or indirect damages arising from your use of the service. Our total liability is limited to the amount you paid us in the three months before the claim.</p>
<h2>Ending your account</h2>
<p>You can delete your account at any time. We may suspend accounts that break these terms.</p>
<h2>Contact</h2>
<p><a href="mailto:support@opentrade.bot">support@opentrade.bot</a></p>`,
  );

export const supportPage = () =>
  doc(
    "Support",
    `
<p>Need help with OpenTrade Cloud or the iPhone app? Email <a href="mailto:support@opentrade.bot">support@opentrade.bot</a> and we'll get back to you within one business day.</p>
<h2>Common questions</h2>
<p><b>How do I approve an order?</b> When an agent wants to place an order you get a notification. Open it, review the order, and tap Approve (confirmed with Face ID) or Reject. Orders that aren't approved before their timer runs out are refused.</p>
<p><b>Where do I create agents?</b> On the web at this site, from a computer. Agents you create show up in the app.</p>
<p><b>How do I delete my account?</b> In the app: Account → Delete account. On the web: Account → Delete my account.</p>
<p><b>Is OpenTrade a broker?</b> No. OpenTrade runs your agents; orders go to the broker or exchange you connect.</p>
<p>OpenTrade is open source: <a href="https://github.com/OpenTradeOSS/OpenTrade">github.com/OpenTradeOSS/OpenTrade</a>.</p>`,
  );
