import type { ApprovalMode, HarnessId } from "@shared/agent";
import {
  ArrowUp,
  Check,
  ChevronsUpDown,
  Cloud,
  File,
  FileText,
  Laptop,
  Repeat,
  ShieldCheck,
  TrendingUp,
  Wand2,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useCreateAgent } from "../../hooks/useCreateAgent";
import { useSettings } from "../../hooks/useSettings";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { HarnessGlyph } from "../icons/HarnessGlyph";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";

type Environment = "local" | "cloud";

interface PickerOption {
  value: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const TEMPLATES: PickerOption[] = [
  { value: "default", icon: <Wand2 className="size-3.5" />, label: "General" },
  { value: "dca", icon: <Repeat className="size-3.5" />, label: "Dollar-cost averaging" },
  { value: "momentum", icon: <TrendingUp className="size-3.5" />, label: "Momentum" },
  { value: "blank", icon: <File className="size-3.5" />, label: "Blank" },
];

const ENVIRONMENTS: PickerOption[] = [
  {
    value: "local",
    icon: <Laptop className="size-3.5" />,
    label: "Local",
    hint: "Runs on this Mac",
  },
  {
    value: "cloud",
    icon: <Cloud className="size-3.5" />,
    label: "Cloud",
    hint: "Soon",
    disabled: true,
  },
];

const APPROVALS: PickerOption[] = [
  {
    value: "approve",
    icon: <ShieldCheck className="size-3.5" />,
    label: "Require approval",
    hint: "You confirm every order",
  },
  {
    value: "auto",
    icon: <Zap className="size-3.5" />,
    label: "Full-auto",
    hint: "Orders execute automatically",
  },
];

/**
 * The New Agent configuration dialog — a wide, CLAUDE.md-centered editor built on
 * shadcn primitives. The agent's
 * CLAUDE.md **specialty section** fills the main text field (a `Textarea` labelled
 * "CLAUDE.md"): picking a template seeds it from that template's own CLAUDE.md
 * (`agents.templateClaudeMd`, prefix excluded), and the user can edit it before
 * creating. The **Blank** template seeds nothing — the field shows its placeholder
 * and the agent gets no starter prompt. The shared OpenTrade prefix (system
 * mechanics) is prepended by the backend at scaffold time and never shown here. A
 * footer row of `Popover` picker pills sets the environment, order approval, and
 * template. Gated on `newAgentOpen`; the form remounts each open so its state
 * resets.
 */
export function NewAgentDialog() {
  const open = useUIStore((s) => s.newAgentOpen);
  const close = useUIStore((s) => s.closeNewAgent);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="w-[44rem] max-w-[92vw] gap-2.5 p-3.5 sm:max-w-[44rem]"
      >
        <DialogTitle className="sr-only">New agent</DialogTitle>
        <DialogDescription className="sr-only">
          Create a new trading agent and edit its instructions.
        </DialogDescription>
        {/* Remount the form each open so its state resets. */}
        {open && <NewAgentForm />}
      </DialogContent>
    </Dialog>
  );
}

function NewAgentForm() {
  const settings = useSettings();
  const { create, isPending } = useCreateAgent();

  const [name, setName] = useState("");
  const [template, setTemplate] = useState("default");
  const [harness, setHarness] = useState<HarnessId>("claude");
  // CLI availability drives the picker: a missing codex install is shown but disabled.
  const probes = trpc.onboarding.harnesses.useQuery(undefined, { staleTime: 60_000 });
  const codexFound = probes.data?.codex.found ?? false;
  const harnessOptions: PickerOption[] = [
    {
      value: "claude",
      icon: <HarnessGlyph harness="claude" />,
      label: "Claude Code",
    },
    {
      value: "codex",
      icon: <HarnessGlyph harness="codex" />,
      label: "Codex",
      // Keep the "not found" note — it explains why the option is disabled.
      hint: codexFound ? undefined : "codex CLI not found",
      disabled: !codexFound,
    },
  ];
  const [environment, setEnvironment] = useState<Environment>("local");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(
    settings.data?.defaultApprovalMode ?? "approve",
  );
  const [claudeMd, setClaudeMd] = useState("");

  // The selected template's specialty section (prefix excluded). Seeds the editor;
  // switching templates reloads (an explicit choice to load that template's doc).
  const tplQuery = trpc.agents.templateClaudeMd.useQuery({ template });
  const seededTemplateRef = useRef<string | null>(null);
  useEffect(() => {
    if (tplQuery.data == null) return;
    if (seededTemplateRef.current === template) return;
    seededTemplateRef.current = template;
    setClaudeMd(tplQuery.data);
  }, [template, tplQuery.data]);

  const canSubmit = !isPending && !!name.trim();
  const submit = () => {
    if (!canSubmit) return;
    create({ name: name.trim(), template, harness, approvalMode, claudeMd });
  };

  const selectedTemplate = TEMPLATES.find((t) => t.value === template) ?? TEMPLATES[0];

  return (
    // ⌘/Ctrl+Enter creates from anywhere in the form (the Dialog handles Escape).
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
      className="flex flex-col gap-2.5"
    >
      {/* Name */}
      <Input
        // biome-ignore lint/a11y/noAutofocus: focusing the name field on open matches the prior behavior
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Agent name"
        maxLength={80}
        className="border-transparent bg-transparent px-1 text-base font-medium shadow-none placeholder:text-muted-foreground/40 focus-visible:border-transparent"
      />

      {/* CLAUDE.md specialty editor */}
      <div className="flex flex-col rounded-lg border border-border bg-foreground/[0.02]">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3.5 py-2 font-mono text-[11px] font-medium text-muted-foreground">
          <FileText className="size-3" />
          {harness === "codex" ? "AGENTS.md" : "CLAUDE.md"}
        </div>
        <Textarea
          value={claudeMd}
          onChange={(e) => setClaudeMd(e.target.value)}
          spellCheck={false}
          placeholder="Write this agent's instructions — its strategy, principles, and journaling. Leave blank for a clean slate."
          className="h-[19rem] resize-none border-transparent bg-transparent px-3.5 py-3 font-mono text-[12px] leading-relaxed shadow-none placeholder:text-muted-foreground/40 focus-visible:border-transparent"
        />
        <div className="flex items-center justify-end px-2.5 pb-2.5">
          <Button
            type="submit"
            size="icon"
            disabled={!canSubmit}
            aria-label="Create agent"
            className="rounded-full"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>

      {/* Footer: environment + approval + template pickers, create hint */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-1.5">
          <PickerPill
            icon={
              environment === "local" ? (
                <Laptop className="size-3.5" />
              ) : (
                <Cloud className="size-3.5" />
              )
            }
            label={environment === "local" ? "Local" : "Cloud"}
            options={ENVIRONMENTS}
            value={environment}
            onValueChange={(v) => setEnvironment(v as Environment)}
          />
          <PickerPill
            icon={<HarnessGlyph harness={harness} />}
            label={harness === "codex" ? "Codex" : "Claude Code"}
            options={harnessOptions}
            value={harness}
            onValueChange={(v) => setHarness(v as HarnessId)}
          />
          <PickerPill
            icon={
              approvalMode === "approve" ? (
                <ShieldCheck className="size-3.5" />
              ) : (
                <Zap className="size-3.5" />
              )
            }
            label={approvalMode === "approve" ? "Require approval" : "Full-auto"}
            options={APPROVALS}
            value={approvalMode}
            onValueChange={(v) => setApprovalMode(v as ApprovalMode)}
          />
          <PickerPill
            icon={selectedTemplate.icon}
            label={selectedTemplate.label}
            options={TEMPLATES}
            value={template}
            onValueChange={setTemplate}
          />
        </div>
        <span className="px-1 text-[11px] text-muted-foreground/50">
          {isPending ? "Creating…" : "⌘↵ to create"}
        </span>
      </div>
    </form>
  );
}

/**
 * A compact footer picker pill: a small `Popover` whose trigger is
 * a bordered pill (icon + current label + chevron) and whose content is a list of
 * options with a check on the selected one. Selecting an enabled option closes it.
 */
function PickerPill({
  icon,
  label,
  options,
  value,
  onValueChange,
}: {
  icon: ReactNode;
  label: string;
  options: PickerOption[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 border-[0.5px] border-border bg-foreground/[0.04] font-normal text-foreground"
        >
          <span className="text-muted-foreground">{icon}</span>
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronsUpDown className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-60 p-1">
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={opt.disabled}
              onClick={() => {
                onValueChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left",
                opt.disabled ? "opacity-40" : "hover:bg-accent",
              )}
              style={opt.disabled ? { cursor: "default" } : undefined}
            >
              <span className="mt-0.5 text-muted-foreground">{opt.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{opt.label}</span>
                {opt.hint && (
                  <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                )}
              </span>
              {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
