import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { isValidEmail, subscribeEmail } from "@/lib/analytics";

type Status = "idle" | "sending" | "done" | "error";

function SignupForm() {
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending" || !isValidEmail(email)) return;
    setStatus("sending");
    try {
      await subscribeEmail(email);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <output className="inline-flex w-full items-center gap-3 rounded-full bg-black/60 py-1.5 pe-5 ps-1.5 text-sm text-(--cs-ink) ring-1 ring-white/15 sm:text-base">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--cs-ink) sm:h-10 sm:w-10">
          <Check className="h-4 w-4 text-black" />
        </span>
        You&rsquo;re on the list. Thanks!
      </output>
    );
  }

  const sending = status === "sending";

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-2">
      <label htmlFor={inputId} className="sr-only">
        Email address
      </label>
      {/* One pill holding both the field and the button, padded like the hero CTAs so the
          button's circle matches theirs. */}
      <div className="flex w-full items-center gap-2 rounded-full bg-black/60 py-1.5 pe-1.5 ps-5 ring-1 ring-white/15 transition-shadow focus-within:ring-white/40">
        <input
          id={inputId}
          type="email"
          name="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          disabled={sending}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-(--cs-ink) placeholder:text-(--cs-muted) focus:outline-none disabled:opacity-60 sm:text-base"
        />
        <button
          type="submit"
          disabled={sending}
          className="group inline-flex shrink-0 items-center gap-2 rounded-full bg-(--cs-ink) py-1 pe-1 ps-4 text-sm font-medium text-black transition-all duration-300 hover:gap-3 disabled:cursor-wait sm:text-base"
        >
          Submit
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black transition-transform duration-300 group-hover:scale-110 sm:h-8 sm:w-8">
            {sending ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-(--cs-cream)" />
            ) : (
              <ArrowRight className="h-3.5 w-3.5 text-(--cs-cream) rtl:rotate-180" />
            )}
          </span>
        </button>
      </div>
      <p aria-live="polite" className="min-h-[1.25rem] text-center text-xs text-(--cs-muted)">
        {status === "error" ? "Couldn’t subscribe right now. Please try again." : null}
      </p>
    </form>
  );
}

/**
 * Mailing-list signup below the hero, reached by normal scrolling: just the centred field on
 * the page's black, so it reads as a continuation of the hero rather than a new section. On
 * phones it only comes into view once the hero's sticky stage and copy release at the end of
 * the screenshot scroll. `relative z-10` keeps it above the hero's aperture, whose 100vmax
 * black shadow spills past the hero section's bottom edge.
 */
export function EmailSignup() {
  return (
    <section
      id="stay-updated"
      aria-labelledby="stay-updated-heading"
      className="relative z-10 flex justify-center bg-black px-4 pb-12 pt-6 max-sm:-mt-32 md:pb-16 md:pt-8"
    >
      <div className="flex w-full max-w-md flex-col gap-3">
        <h2
          id="stay-updated-heading"
          className="text-center text-sm text-(--cs-ink)/70 sm:text-base"
          style={{ lineHeight: 1.3 }}
        >
          Get an email when there&rsquo;s something new in OpenTrade.
        </h2>
        <SignupForm />
      </div>
    </section>
  );
}
