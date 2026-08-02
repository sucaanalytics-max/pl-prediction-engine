import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import MobileBottomNav from "@/components/MobileBottomNav";
import PwaManager from "@/components/PwaManager";
import { FplLiveProvider } from "@/lib/FplLiveContext";
import { PredictionsProvider } from "@/lib/PredictionsContext";
import { Providers } from "./providers";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
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
    <html lang="en" suppressHydrationWarning className={`${jakarta.variable} ${mono.variable}`}>
      <head>
        <meta name="theme-color" content="#07130f" />
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
        <Providers>
          <FplLiveProvider>
            <PredictionsProvider>
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
            </PredictionsProvider>
          </FplLiveProvider>
        </Providers>
      </body>
    </html>
  );
}
