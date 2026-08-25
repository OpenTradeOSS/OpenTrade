// The upstream template loads these through `next/font/google`. This site is built
// with Vite, so the faces are loaded via a <link> in `index.html` and exposed as the
// `--font-almarai` / `--font-instrument-serif` tokens in `src/index.css`. These
// objects keep the template's `almarai.variable` call sites working unchanged.
export const almarai = { variable: "font-almarai" } as const;
export const instrumentSerif = { variable: "font-instrument-serif" } as const;
