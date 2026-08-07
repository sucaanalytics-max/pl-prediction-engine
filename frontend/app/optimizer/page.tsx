import { redirect } from "next/navigation";

/**
 * Superseded by `/decide`.
 *
 * Its multi-transfer plans are the "Alternatives" section, now labelled with how
 * far behind the best each one is — a 0.2-point gap means "either", which the
 * sliders never said. The risk/free-transfer sliders did not move: they re-scored
 * an unvalidated heuristic with four more untested constants.
 *
 * Redirected rather than deleted: the service worker and any bookmark still
 * point here. This route was never on `main` and returned 404 in production,
 * so nothing that ever worked is being taken away.
 */
export default function OptimizerRedirect() {
  redirect("/decide");
}
