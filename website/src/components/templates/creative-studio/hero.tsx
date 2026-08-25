import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";

import appWindow from "@/assets/app-window.jpg";
import opentradeLogo from "@/assets/opentrade-logo-type-mono.svg";
import { track } from "@/lib/analytics";

import { CinematicBackground, NoiseOverlay } from "./primitives";

const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

// Pinned to a specific release because the asset filename embeds the version, so GitHub's
// `/releases/latest/download/<name>` permalink would 404 on the next release. Bump this on
// every release until the DMG gets a version-less `artifactName` in electron-builder.yml,
// after which the permalink can be used directly. Apple silicon only — no x64 build ships.
const DOWNLOAD_URL =
  "https://github.com/OpenTradeOSS/OpenTrade/releases/download/v0.2.5/OpenTrade-0.2.5-arm64.dmg";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 .7C5.63.7.5 5.83.5 12.2c0 5.1 3.3 9.42 7.84 10.95.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.1-3.19.69-3.86-1.35-3.86-1.35-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.69.08-.69 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.67 1.24 3.32.95.1-.74.4-1.24.73-1.52-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18A10.9 10.9 0 0 1 12 6.13c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.8 1.18 1.83 1.18 3.08 0 4.41-2.68 5.38-5.24 5.67.41.36.78 1.06.78 2.14 0 1.55-.02 2.79-.02 3.17 0 .3.21.66.79.55A11.51 11.51 0 0 0 23.5 12.2C23.5 5.83 18.37.7 12 .7Z" />
    </svg>
  );
}

export function Hero({ videoSrc, posterSrc }: { videoSrc?: string; posterSrc?: string }) {
  const reduce = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end end"],
  });
  const mobileWindowY = useTransform(scrollYProgress, [0, 0.68, 1], ["0dvh", "-68dvh", "-72dvh"]);

  const fade = (delay: number) => ({
    initial: reduce ? false : { y: 20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    transition: { duration: 0.8, delay, ease: EASE_OUT_EXPO },
  });

  return (
    <section ref={heroRef} className="relative h-[140dvh] w-full bg-black p-4 sm:h-dvh md:p-6">
      <div className="sticky top-4 flex h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-black sm:relative sm:top-auto md:h-[calc(100dvh-3rem)] md:rounded-[2rem]">
        {videoSrc ? (
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src={videoSrc}
            poster={posterSrc}
            autoPlay
            loop
            muted
            playsInline
          />
        ) : (
          <CinematicBackground variant="hero" />
        )}

        <NoiseOverlay className="opacity-[0.35] mix-blend-overlay" />

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/5 via-transparent to-black/20"
        />

        {/* Mobile: two scroll-linked crops reveal the left and right panels in sequence. */}
        <motion.div
          aria-hidden
          className="absolute inset-x-0 top-[4dvh] z-[5] flex flex-col gap-[10dvh] sm:hidden"
          style={{ y: mobileWindowY }}
        >
          <img
            src={appWindow}
            alt=""
            width={2536}
            height={1482}
            className="ml-[2%] h-auto w-[260%] max-w-none self-start rounded-lg shadow-[0_30px_100px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
          />
          <img
            src={appWindow}
            alt=""
            width={2536}
            height={1482}
            className="mr-[2%] h-auto w-[260%] max-w-none self-end rounded-lg shadow-[0_30px_100px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
          />
        </motion.div>

        {/* Tablet and desktop retain the original single centered window. */}
        <motion.div
          initial={reduce ? false : { y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1, delay: 0.25, ease: EASE_OUT_EXPO }}
          className="absolute left-1/2 top-[42%] z-[5] hidden w-[84%] -translate-x-1/2 -translate-y-1/2 sm:block lg:w-[74%] xl:w-[72%] xl:max-w-[100rem]"
        >
          <img
            src={appWindow}
            alt="The OpenTrade app: agent sidebar, the selected agent's live Claude Code terminal, and its portfolio panel"
            width={2536}
            height={1482}
            className="h-auto w-full origin-top scale-[1.08] rounded-lg shadow-[0_30px_100px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10 lg:rounded-xl"
          />
        </motion.div>

        <div className="relative z-10 mt-auto p-4 sm:p-6 md:p-8 lg:p-10">
          {/* Legibility scrim: black at the bottom edge → transparent just above the text block. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-[45%] bottom-0 -z-10"
            style={{
              background:
                "linear-gradient(to top, rgb(0 0 0) 0%, rgb(0 0 0) 40%, rgb(0 0 0 / 0) 100%)",
            }}
          />
          <div className="grid grid-cols-12 items-end gap-6 md:gap-8">
            <div className="col-span-12 lg:col-span-8">
              <h1 className="relative max-sm:-left-2 max-sm:top-2">
                <motion.img
                  {...fade(0.25)}
                  src={opentradeLogo}
                  alt="OpenTrade"
                  width={451}
                  height={120}
                  className="h-auto w-[74vw] max-w-[48rem] md:w-[58vw] lg:w-[46vw] lg:max-w-[44rem]"
                />
              </h1>
            </div>

            <div className="col-span-12 flex flex-col gap-4 md:gap-6 lg:col-span-4 lg:items-end 2xl:pr-6">
              <motion.p
                {...fade(0.5)}
                className="w-full max-w-md text-[clamp(0.875rem,1.1vw,1rem)] text-(--cs-ink)/70"
                style={{ lineHeight: 1.3 }}
              >
                An open-source trading harness for Claude Code and Codex agents. Agents can trade
                through Robinhood&rsquo;s official MCP, run custom market-watch scripts, operate
                within enforced guardrails, and run in the background &mdash; all on your machine.
              </motion.p>

              <motion.div
                {...fade(0.7)}
                className="flex w-full max-w-md flex-wrap items-center gap-3"
              >
                <a
                  href={DOWNLOAD_URL}
                  onClick={() => track("download_clicked")}
                  className="group inline-flex w-fit items-center gap-2 rounded-full bg-(--cs-ink) py-1.5 pe-1.5 ps-5 text-sm font-medium text-black transition-all duration-300 hover:gap-3 sm:text-base"
                >
                  Download for macOS
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black transition-transform duration-300 group-hover:scale-110 sm:h-10 sm:w-10">
                    <ArrowRight className="h-4 w-4 text-(--cs-cream) rtl:rotate-180" />
                  </span>
                </a>
                <a
                  href="https://github.com/OpenTradeOSS/OpenTrade"
                  onClick={() => track("github_clicked")}
                  className="group inline-flex w-fit items-center gap-2 rounded-full bg-black py-1.5 pe-1.5 ps-5 text-sm font-medium text-(--cs-ink) transition-all duration-300 hover:gap-3 sm:text-base"
                >
                  View on GitHub
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 transition-transform duration-300 group-hover:scale-110 sm:h-10 sm:w-10">
                    <GitHubMark className="h-4 w-4 text-(--cs-ink)" />
                  </span>
                </a>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
