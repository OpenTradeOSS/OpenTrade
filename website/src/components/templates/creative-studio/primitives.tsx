import { motion, useInView, useReducedMotion } from "motion/react";
import * as React from "react";

import heroGradient from "@/assets/hero-gradient.jpg";
import { cn } from "@/lib/utils";

const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

function noiseDataUri(baseFrequency: number, numOctaves: number) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>` +
    `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='${numOctaves}' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.55 0'/></filter>` +
    `<rect width='100%' height='100%' filter='url(#n)'/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

const OVERLAY_NOISE = noiseDataUri(0.85, 3);
const BG_NOISE = noiseDataUri(0.9, 4);

const CARD_GRADIENT =
  "radial-gradient(55% 55% at 32% 28%, rgba(222,219,200,0.14), transparent 70%)," +
  "radial-gradient(50% 50% at 72% 78%, rgba(150,138,116,0.20), transparent 72%)," +
  "#0b0a09";

const VIGNETTE = {
  hero: "radial-gradient(125% 120% at 50% 0%, transparent 68%, rgba(0,0,0,0.12) 100%)",
  card: "radial-gradient(125% 120% at 50% 0%, transparent 52%, rgba(0,0,0,0.55) 100%)",
} as const;

export function NoiseOverlay({
  variant = "overlay",
  className,
}: {
  variant?: "overlay" | "bg";
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        backgroundImage: variant === "overlay" ? OVERLAY_NOISE : BG_NOISE,
        backgroundSize: "160px 160px",
      }}
    />
  );
}

export function CinematicBackground({
  variant = "hero",
  className,
}: {
  variant?: "hero" | "card";
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div aria-hidden className={cn("absolute inset-0 overflow-hidden bg-black", className)}>
      {variant === "hero" ? (
        <div
          className="absolute -inset-1 scale-[1.01] bg-cover bg-center bg-no-repeat blur-[1px]"
          style={{ backgroundImage: `url(${heroGradient})` }}
        />
      ) : (
        <motion.div
          className="absolute -inset-1/3"
          style={{ background: CARD_GRADIENT, filter: "blur(40px)" }}
          animate={
            reduce
              ? undefined
              : {
                  x: ["-3%", "3%", "-3%"],
                  y: ["-2%", "2%", "-2%"],
                  rotate: [0, 6, 0],
                  scale: [1, 1.12, 1],
                }
          }
          transition={{
            duration: 34,
            repeat: Number.POSITIVE_INFINITY,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
        />
      )}
      <div className="absolute inset-0" style={{ background: VIGNETTE[variant] }} />
    </div>
  );
}

function WithAsterisk({ word }: { word: string }) {
  const chars = Array.from(word);
  const last = chars.pop() ?? "";
  return (
    <>
      {chars.join("")}
      <span className="relative inline-block">
        {last}
        <span className="absolute -end-[0.3em] top-[0.1em] text-[0.31em]">*</span>
      </span>
    </>
  );
}

export function WordsPullUp({
  text,
  className,
  wordClassName,
  showAsterisk = false,
  startDelay = 0,
  stagger = 0.08,
}: {
  text: string;
  className?: string;
  wordClassName?: string;
  showAsterisk?: boolean;
  startDelay?: number;
  stagger?: number;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const words = text.split(" ");
  const show = reduce || inView;

  return (
    <span
      ref={ref}
      className={cn("inline-flex flex-wrap", className)}
      style={{ columnGap: "0.25em" }}
    >
      {words.map((word, i) => {
        const last = i === words.length - 1;
        return (
          <motion.span
            // biome-ignore lint/suspicious/noArrayIndexKey: static word list; duplicates are legal
            key={i}
            className={cn("inline-block", wordClassName)}
            initial={reduce ? false : { y: 20, opacity: 0 }}
            animate={show ? { y: 0, opacity: 1 } : undefined}
            transition={{
              duration: 0.6,
              delay: startDelay + i * stagger,
              ease: EASE_OUT_EXPO,
            }}
          >
            {last && showAsterisk ? <WithAsterisk word={word} /> : word}
          </motion.span>
        );
      })}
    </span>
  );
}
