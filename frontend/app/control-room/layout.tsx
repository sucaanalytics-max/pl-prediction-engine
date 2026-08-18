import type { Metadata } from "next";

/**
 * The control room's edges.
 *
 * ## Cancelling the shell's gutters
 *
 * The root layout wraps every page in a padded, max-width container, which is
 * right for a document and wrong for a board that carries its own frame: this
 * screen is a 1px-ruled sheet with an editorial 1240px measure inside it, and two
 * nested measures read as a mistake. The negative margins undo exactly the root
 * layout's padding and nothing else — the sidebar stays, because this is a screen
 * in this app rather than a separate application, and a full-bleed page with no way
 * back to the rest of it would be a dead end. Same treatment `/margin` takes, for
 * the same reason.
 *
 * ## No breakpoints
 *
 * The design is desktop, 1600px, dense, and says so: responsive was explicitly not
 * designed and is not to be invented. The measure is fixed and the page scrolls
 * horizontally below it rather than reflowing into a layout nobody drew.
 */

export const metadata: Metadata = {
  title: "Control room — what needs you, across all three teams",
  description:
    "One desk for three FPL entries: the deadline, what wants an answer, and where "
    + "the three teams stand — with every figure carrying where it came from.",
};

export default function ControlRoomLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-9 -my-7 lg:-my-9">
      {children}
    </div>
  );
}
