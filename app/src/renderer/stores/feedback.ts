import { create } from "zustand";

/**
 * The feedback form's draft. Lives outside the component because the popover unmounts
 * its content on close — a stray outside click must not throw away a half-written
 * message. Cleared only on a successful send. Session-only.
 */
interface FeedbackDraft {
  /** Per-draft id, sent along so a retried submission can't be stored twice. */
  submissionId: string;
  message: string;
  email: string;
  includeDiagnostics: boolean;
  setMessage: (message: string) => void;
  setEmail: (email: string) => void;
  setIncludeDiagnostics: (on: boolean) => void;
  reset: () => void;
}

const fresh = () => ({
  submissionId: crypto.randomUUID(),
  message: "",
  email: "",
  includeDiagnostics: true,
});

export const useFeedbackStore = create<FeedbackDraft>((set) => ({
  ...fresh(),
  setMessage: (message) => set({ message }),
  setEmail: (email) => set({ email }),
  setIncludeDiagnostics: (includeDiagnostics) => set({ includeDiagnostics }),
  reset: () => set(fresh()),
}));
