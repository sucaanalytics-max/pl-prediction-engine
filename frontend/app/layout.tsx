import type { Metadata } from "next";
import { Anton, Archivo, DM_Mono } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import MobileBottomNav from "@/components/MobileBottomNav";
import PwaManager from "@/components/PwaManager";
import { Providers } from "./providers";

/**
 * Archivo and DM Mono, app-wide — the pair the redesign was drawn in.
 *
 * IBM Plex Sans and Mono were here, and were kept through the floodlit palette
 * change on the argument that Plex Mono's figures were what let a column of
 * projections compare by eye. That argument was sound about mono figures in
 * general and wrong about which face: the artboards this app is being built from
 * are set in Archivo and DM Mono, so shipping Plex meant every screen was a near
 * miss of its own design — the single largest reason the running app did not look
 * like the thing that was approved.
 *
 * DM Mono keeps what Plex Mono was chosen for. It is monospaced with tabular
 * figures by construction, so a heat grid's columns still line up; it is drawn
 * lighter and narrower, which is what lets a 10px figure sit inside a 24px cell
 * without crowding the colour it sits on.
 *
 * Archivo replaces Plex Sans for the same reason and one more: it is a grotesque
 * with a genuine 600, so an uppercase tracked label reads as apparatus at 9px
 * without needing a mono face to carry it.
 *
 * ## Weights, and the one that had to move
 *
 * DM Mono publishes 300, 400 and 500 — there is no 600, 700 or 800. Plex Mono had
 * them and a handful of rules asked for 700 and 800, which a browser would
 * synthesise into a faux bold that thickens the stroke without changing the
 * skeleton. Those rules now ask for 500 and the emphasis they wanted comes from
 * Anton or from case and tracking, which is how the artboards do it.
 *
 * Italic is loaded on Archivo because it carries the typographic hedge this app
 * puts on a heuristic number, which is a real distinction and not decoration.
 */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-archivo",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

/**
 * The display face, and the one typographic change in the floodlit redesign.
 *
 * Newsreader was a serif built for reading at length, which suited a surface
 * that no longer exists. Anton is a heavy condensed grotesque — back-page
 * scoreboard rather than book page — and it does one job: the single figure a
 * screen exists to deliver, at a size nothing else competes with.
 *
 * It is the one face the artboards and the old app already agreed on, which is
 * why it survived the type swap above unchanged.
 *
 * Anton ships a single weight by design, so there is no 400/500 pair to load.
 */
const anton = Anton({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-display-anton",
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
      className={`${archivo.variable} ${dmMono.variable} ${anton.variable}`}
    >
      <head>
        {/* The chrome colour — see `--chrome`, and keep the two in step. */}
        <meta name="theme-color" content="#14181d" />
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
