import { cn } from "@/lib/utils";

import { almarai, instrumentSerif } from "./fonts";
import { Hero } from "./hero";

// The `--cs-*` palette tokens for `.creative-studio` live in `src/index.css`.
export default function CreativeStudio() {
  return (
    <div
      className={cn(
        "creative-studio",
        almarai.variable,
        instrumentSerif.variable,
        "bg-black text-(--cs-ink) antialiased",
      )}
      style={{
        fontFamily: "var(--font-almarai), ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <Hero />
    </div>
  );
}
