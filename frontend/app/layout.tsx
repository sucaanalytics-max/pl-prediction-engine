import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import { PredictionsProvider } from "@/lib/PredictionsContext";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
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
    <html lang="en" className={`dark ${dmSans.variable} ${mono.variable}`}>
      <head>
        <meta name="theme-color" content="#070c14" />
      </head>
      <body className="min-h-screen">
        <PredictionsProvider>
          <div className="flex min-h-screen">
            <Navigation />
            <main
              id="main-content"
              className="flex-1 ml-0 lg:ml-64"
              style={{ borderTop: "1px solid rgba(42, 173, 31, 0.08)" }}
            >
              <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {children}
              </div>
            </main>
          </div>
        </PredictionsProvider>
      </body>
    </html>
  );
}
