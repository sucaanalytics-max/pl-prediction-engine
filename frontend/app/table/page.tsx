import { redirect } from "next/navigation";

/**
 * Superseded by `/matches`, which carries the league table alongside the fixtures.
 *
 * Redirected only after parity: P, W, D, L, GF, GA, GD, Pts and the form guide all
 * moved across, along with the qualification zones.
 *
 * The zone logic itself did not move unchanged — it was the bug. This page asked
 * `getZone(pos)`, and with `position: 0` on every row of the committed artifact
 * `pos <= 4` was true for all twenty clubs. `deriveZone(club, table)` takes the
 * whole table so the question cannot be asked before a ball is kicked, and it
 * gates on matches played rather than on position, which is the only check that
 * survives the writer starting to assign 1..20.
 */
export default function TableRedirect() {
  redirect("/matches");
}
