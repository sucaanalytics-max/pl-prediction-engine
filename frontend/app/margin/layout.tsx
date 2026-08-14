import type { Metadata } from "next";

/**
 * Margin's edges.
 *
 * ## The fonts moved up
 *
 * This layout used to load IBM Plex itself, because Margin was the only screen
 * set in it and every other route was Plus Jakarta. The app is now set in Plex
 * throughout, so the faces come from the root layout and this route no longer
 * ships a second copy of them.
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

export const metadata: Metadata = {
  title: "Margin — the call, and how much of it is noise",
  description:
    "The decision, what argues with it, every player as a distribution, and what "
    + "has decayed since the last solve.",
};

export default function MarginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-9 -my-7 lg:-my-9">
      {children}
    </div>
  );
}
