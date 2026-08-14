import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import MobileBottomNav from "@/components/MobileBottomNav";
import PwaManager from "@/components/PwaManager";
import { Providers } from "./providers";

/**
 * IBM Plex, app-wide.
 *
 * Plus Jakarta and JetBrains Mono were the previous pair. The swap is not a
 * preference: Plex Mono's figures are what let a column of projections line up
 * under each other well enough to compare two players by eye, and the italic is
 * what carries the typographic hedge this app puts on every heuristic number.
 * Both faces are loaded here rather than per route, so `/margin` no longer ships
 * its own copy.
 *
 * The `--font-plex-*` variable names are what `globals.css` reads. `--font-mono`
 * is kept pointing at the same face because roughly thirty rules and several
 * components still name it, and renaming those is a separate, noisier change.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
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
      className={`${plexSans.variable} ${plexMono.variable}`}
    >
      <head>
        {/* The chrome colour, which is ink on both surfaces — see `--chrome`. */}
        <meta name="theme-color" content="#14140f" />
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
          <div className="flex min-h-screen">
            <Navigation />
            <main
              id="main-content"
              className="w-full min-w-0 flex-1 ml-0 lg:ml-[264px] transition-all duration-500"
            >
              <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-9 py-7 lg:py-9">
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
