import { CreditCard, KeyRound } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { IS_WEB } from "../../lib/web";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/**
 * OpenTrade Cloud only: links to the gateway's account page (plan, credits, keys) and
 * the "finish a sign-in" helper for agent CLI logins. Renders nothing on the desktop.
 */
export function HostedLinks() {
  if (!IS_WEB) return null;
  const linkClass =
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent";
  return (
    <>
      <a href="/oauth/finish" className={linkClass}>
        <KeyRound className="size-4" /> Finish a sign-in
      </a>
      <a href="/account" className={linkClass}>
        <CreditCard className="size-4" /> Account & credits
      </a>
    </>
  );
}

/**
 * OpenTrade Cloud only: the sandbox has no browser, so a URL the host would open on the
 * desktop (the Robinhood consent) arrives here and is offered as a link to click.
 */
export function HostedOpenUrl() {
  const [pending, setPending] = useState<{ url: string; purpose: string } | null>(null);
  trpc.system.onOpenUrl.useSubscription(undefined, {
    enabled: IS_WEB,
    onData: (p) => setPending(p),
  });
  if (!IS_WEB) return null;
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Continue to Robinhood</DialogTitle>
          <DialogDescription>
            Sign in to Robinhood in a new tab to connect it. You'll come back here when you're done.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button asChild>
            <a
              href={pending?.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setPending(null)}
            >
              Open Robinhood
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
