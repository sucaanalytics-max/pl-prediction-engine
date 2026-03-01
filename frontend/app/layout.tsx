import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
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
  title: "PL Prediction Engine",
  description:
    "Bayesian match predictions for the Premier League — Dixon-Coles, XGBoost, Monte Carlo simulation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${jakarta.variable} ${mono.variable}`}>
      <head>
        <meta name="theme-color" content="#0a0f1c" />
      </head>
      <body className="min-h-screen">
        <Providers>
          <PredictionsProvider>
            <div className="flex min-h-screen">
              <Navigation />
              <main
                id="main-content"
                className="flex-1 ml-0 lg:ml-64"
                style={{ borderTop: "1px solid var(--accent-border)" }}
              >
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                  {children}
                </div>
              </main>
            </div>
          </PredictionsProvider>
        </Providers>
      </body>
    </html>
  );
}
