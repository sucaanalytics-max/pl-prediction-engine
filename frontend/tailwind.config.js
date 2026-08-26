/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // No `colors` block. The twelve-shade `pitch` palette and the three `slate`
      // overrides were the previous theme's; no utility referenced any of them, and
      // two of the fifteen still carried their conversion notes ("Electric
      // Emerald", "the new deep cyber dark"). Colour in this app comes from the
      // custom properties in `globals.css` and the surface tokens in
      // `lib/margin/tokens.ts` — a second, unreachable palette in the build config
      // is how a screen ends up half on each.
      //
      // `--font-jakarta` no longer exists — the app is set in IBM Plex — so
      // `font-display` and `font-body` were resolving to system-ui wherever they
      // were used. Pointed at the tokens `globals.css` actually defines.
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      // No `animation`/`keyframes` block either.
      //
      // `fade-in`, `pulse-glow` and `spin-slow` had no user, and `pulseGlow` still
      // carried `drop-shadow(0 0 15px rgba(0,255,163,0.5))` — the neon this app's
      // own stylesheet header removed on the grounds that "a glow is a claim".
      //
      // `slide-up` DID have a user (`app/offline/page.tsx`) and that is exactly why
      // it goes: `globals.css` defines both `@keyframes slide-up` and
      // `.animate-slide-up` itself, so two rules of equal specificity were fighting
      // over one class name and which won depended on stylesheet order. One
      // definition, in the file that owns the animation.
    },
  },
  plugins: [],
};
