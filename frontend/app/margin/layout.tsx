import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

/**
 * Margin's own type and its own edges.
 *
 * ## Two fonts the rest of the app does not load
 *
 * The app is set in Plus Jakarta and JetBrains Mono. Margin is set in IBM Plex,
 * and the pair is doing work rather than decorating: the research table puts
 * fourteen numeric columns on one row, and Plex Mono's figures are the reason
 * the distribution glyphs line up under each other well enough to compare two
 * players by eye. Loaded here rather than in the root layout so every other
 * route keeps paying for exactly the two faces it uses.
 *
 * ## Cancelling the shell's gutters
 *
 * The root layout wraps every page in a padded, max-width container, which is
 * right for a document and wrong for a workspace whose bar is sticky and whose
 * table scrolls. The negative margins here undo exactly that padding and nothing
 * else — the sidebar stays, because Margin is a screen in this app and not a
 * separate application, and a full-bleed page with no way back to the rest of it
 * would be a dead end.
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
  title: "Margin — the call, and how much of it is noise",
  description:
    "The decision, what argues with it, every player as a distribution, and what "
    + "has decayed since the last solve.",
};

export default function MarginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`${plexSans.variable} ${plexMono.variable} -mx-4 sm:-mx-6 lg:-mx-9 -my-7 lg:-my-9`}
    >
      {children}
    </div>
  );
}
