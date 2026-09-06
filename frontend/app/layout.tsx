import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import MobileBottomNav from "@/components/MobileBottomNav";
import PwaManager from "@/components/PwaManager";
import { Providers } from "./providers";

/**
 * IBM Plex Sans, app-wide, and the only face the app loads.
 *
 * Signal's typographic claim is that one family does every job: `MONO`, `SANS`
 * and `DISPLAY` in `lib/margin/tokens.ts` all resolve to this variable, and a
 * figure is separated from its label by weight rather than by shape.
 *
 * ## What this removes, and why none of it is lost
 *
 * Anton, Archivo and DM Mono were the floodlit set — a condensed poster face for
 * the one big figure, a grotesque for prose, a monospace for columns. All three
 * were chosen against a dark scoreboard surface that no longer exists.
 *
 * DM Mono was carried for equal-width FIGURES so a projection column compares by
 * eye. That property belongs to `font-variant-numeric: tabular-nums`, which
 * `globals.css` sets on the body and which Plex answers; what a monospaced face
 * adds beyond it is equal-width letters, which nothing here needed and which is
 * what made every tracked label read as a terminal.
 *
 * Anton set the single figure a screen delivers. On paper that figure is set
 * large in this family at 600 and the SIZE does the work the condensed face used
 * to do with weight and width.
 *
 * Weights 400–700 are all loaded because one family now has to cover apparatus
 * (400/500), labels and emphasis (600) and the display figure (700) — the four
 * the stylesheet and the components actually name. Italic carries the
 * typographic hedge this app puts on a heuristic number, which is a real
 * distinction and not decoration, so it comes too.
 *
 * IBM Plex Sans was in this file once before and was removed for looking like a
 * near miss of artboards drawn in Archivo. It returns because the artboards
 * changed: Signal is drawn in Plex, and the app and its design agree again.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-plex-sans",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Suca — FPL Decision OS",
  description:
    "A personal FPL decision workspace for transfers, captaincy, fixtures, injury news and projection analysis.",
  openGraph: {
    title: "Suca — FPL Decision OS",
    description: "Know the move. Know why. Transfers, captaincy and intelligence in one FPL workspace.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Suca FPL Decision OS" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Suca — FPL Decision OS",
    description: "Know the move. Know why. Transfers, captaincy and intelligence in one FPL workspace.",
    images: ["/og.png"],
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Suca FPL",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable}`}
    >
      <head>
        {/* The chrome colour — see `--chrome`, and keep the two in step. */}
        <meta name="theme-color" content="#f1f2f4" />
        {/*
          Wrangler's production bundling preserves function names inside the
          next-themes bootstrap before that function is serialized as an inline
          script. Define the tiny esbuild helpers first so the saved theme is
          applied without a ReferenceError in the Cloudflare worker runtime.
        */}
        <script
          id="function-name-helpers"
          dangerouslySetInnerHTML={{
            __html:
              'globalThis.__name=globalThis.__name||((target,value)=>Object.defineProperty(target,"name",{value,configurable:true}));globalThis.__name2=globalThis.__name2||globalThis.__name;',
          }}
        />
      </head>
      <body className="min-h-screen">
        {/* No data providers. Both were removed: each fetched on mount for
            every page in the tree whether or not the page used the data, shared
            one `loading` and one `error` across every consumer so a single
            failure blanked unrelated sections, and cast the response with
            `as T`. Pages now load what they need through `useArtifact`, and
            each section owns its own state. */}
        <Providers>
          {/* A column, not a row. `Navigation` is a top bar now, so `main`
              needs no left offset — the 264px the sidebar reserved on every
              viewport went back to the tables, which are the reason these
              screens exist. The wider max-width is the same decision: the
              projection grid is players across eight gameweeks. */}
          <div className="flex min-h-screen flex-col">
            <Navigation />
            <main id="main-content" className="w-full min-w-0 flex-1">
              <div className="max-w-[1680px] mx-auto px-4 sm:px-5 lg:px-6 py-5 lg:py-6">
                {children}
              </div>
            </main>
          </div>
          <MobileBottomNav />
          <PwaManager />
        </Providers>
      </body>
    </html>
  );
}
