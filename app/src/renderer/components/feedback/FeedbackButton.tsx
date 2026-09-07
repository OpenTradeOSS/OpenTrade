import { FEEDBACK_MESSAGE_MAX, FeedbackInput } from "@shared/feedback";
import { Check, ExternalLink, Loader2, MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connection";
import { useFeedbackStore } from "../../stores/feedback";
import { useUIStore } from "../../stores/ui";
import { SettingToggle } from "../settings/SettingToggle";
import { OPENTRADE_DISCORD_URL } from "../settings/TelemetryOptOutDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** How long the trigger icon shows the green check after a successful send. */
const SENT_FLASH_MS = 3000;

/**
 * The in-app feedback entry point (§12.8), at the right end of the `RightPanel` footer.
 * The popover is `modal` because xterm stops bubble-phase events, so a non-modal
 * outside-click dismiss never fires over the terminal.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  // After a send the popover closes at once and the icon crossfades to a green check.
  const [justSent, setJustSent] = useState(false);
  const backendConnected = useConnectionStore((s) => s.backendConnected);

  useEffect(() => {
    if (!justSent) return;
    const t = setTimeout(() => setJustSent(false), SENT_FLASH_MS);
    return () => clearTimeout(t);
  }, [justSent]);

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Send feedback"
              disabled={!backendConnected}
              className={cn(
                "relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
                "hover:bg-accent hover:text-foreground disabled:opacity-50",
                "data-[state=open]:bg-accent data-[state=open]:text-foreground",
              )}
            >
              <MessageSquare
                className={cn(
                  "absolute size-4 transition-all duration-300",
                  justSent ? "scale-50 opacity-0" : "scale-100 opacity-100",
                )}
              />
              <Check
                className={cn(
                  "absolute size-4 text-success transition-all duration-300",
                  justSent ? "scale-100 opacity-100" : "scale-50 opacity-0",
                )}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Send feedback</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-[30rem] p-5">
        <FeedbackForm
          onClose={() => setOpen(false)}
          onSent={() => {
            setOpen(false);
            setJustSent(true);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function FeedbackForm({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const draft = useFeedbackStore();
  const view = useUIStore((s) => s.view);
  const available = trpc.feedback.available.useQuery();
  const send = trpc.feedback.send.useMutation();
  const [error, setError] = useState<"email" | "send" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // No PostHog client in this build (no key, or dev without OPENTRADE_ANALYTICS_DEV=1):
  // the form still renders in full, only Send is disabled.
  const unavailable = available.data?.available === false;
  const canSend =
    available.data?.available === true && draft.message.trim() !== "" && !send.isPending;

  const submit = async () => {
    if (!canSend) return;
    const email = draft.email.trim() || undefined;
    if (!FeedbackInput.shape.email.safeParse(email).success) {
      setError("email");
      return;
    }
    setError(null);
    try {
      const result = await send.mutateAsync({
        submissionId: draft.submissionId,
        message: draft.message.trim(),
        email,
        includeDiagnostics: draft.includeDiagnostics,
        view,
      });
      if (!result.ok) throw new Error("send failed");
      draft.reset();
      onSent();
    } catch {
      setError("send");
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ shortcut for the form; each field is still individually focusable.
    <div
      className="space-y-5"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <p className="text-base font-semibold">Send feedback</p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mr-1.5 -mt-1.5 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <Textarea
        ref={textareaRef}
        value={draft.message}
        onChange={(e) => draft.setMessage(e.target.value)}
        maxLength={FEEDBACK_MESSAGE_MAX}
        rows={5}
        placeholder="Bugs, ideas, feature requests, brokers to support, etc."
        // Match the Input's lighter placeholder so the two fields read as one style.
        className="resize-none px-3 py-2.5 leading-relaxed placeholder:text-muted-foreground/60"
      />

      <div className="space-y-1.5">
        <Input
          type="email"
          value={draft.email}
          onChange={(e) => draft.setEmail(e.target.value)}
          placeholder="Email (optional)"
          autoComplete="email"
          spellCheck={false}
          className="py-2"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          We'll get back to you within 12 hours.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Include anonymous app data</span>
          <SettingToggle
            checked={draft.includeDiagnostics}
            onChange={draft.setIncludeDiagnostics}
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Generic app data to help debug issues. Never includes conversations, orders, positions,
          tickers, account details, or any identifying information.
        </p>
      </div>

      {error === "email" && (
        <p className="text-xs text-destructive">Enter a valid email, or leave it blank.</p>
      )}
      {error === "send" && (
        <p className="text-xs text-destructive">
          Couldn't send. Try again, or <DiscordLink label="reach us on Discord" />
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-muted-foreground">
          {unavailable ? (
            "Not available in this build."
          ) : (
            <DiscordLink label="Join our Discord server" />
          )}
        </span>
        <Button type="button" disabled={!canSend} onClick={() => void submit()}>
          {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {send.isPending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

function DiscordLink({ label }: { label: string }) {
  return (
    <a
      href={OPENTRADE_DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}
