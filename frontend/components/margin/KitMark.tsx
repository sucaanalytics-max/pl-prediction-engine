/**
 * An abstracted shirt: two colours, a pattern, and a shoulder notch.
 *
 * Recovered with `lib/margin/kits.ts` — see that file for why the club is worth a
 * hue at all, and why no lettering appears on it.
 *
 * The notch is what makes 15×19px read as a shirt rather than as a colour chip, and
 * it is the entire silhouette budget: one polygon, no crest, no sponsor, no sleeves,
 * no render, no network request. Nothing here is licensed.
 *
 * ## Why an SVG and not a clipped div
 *
 * It shipped as a `<span>` with `clipPath` and `border: 1px solid KIT_OUTLINE`, and
 * those two do not compose. `clip-path` clips the element's whole rendering, border
 * included, to the polygon; a CSS border is painted along the four edges of the
 * BORDER BOX. So the outline survived on the left, right, bottom and the 22%–78%
 * middle of the top — and vanished along both shoulder diagonals, which are the only
 * part of the shape this component exists to draw. The outline was missing from the
 * notch and present everywhere it was not needed.
 *
 * A `<polygon>` with a `stroke` follows the silhouette, shoulders included, because
 * a stroke is a property of the path rather than of a rectangle behind it. The
 * pattern rides in as a `<linearGradient>`/`<pattern>` fill on the same polygon, so
 * fill and outline are guaranteed to describe the same shape.
 *
 * ## It is never the only thing saying which club
 *
 * Ten club pairs remain indistinguishable after colour and pattern — Liverpool and
 * Man United are both plain reds, as they are in life. So the mark carries an
 * `aria-label` and the row keeps its three-letter code. A reader who cannot tell
 * two shirts apart has lost nothing; a reader who can has saved a comparison.
 */
import { type Kit, kitFor, kitTone, KIT_OUTLINE } from "@/lib/margin/kits";

/**
 * The shoulder line, in the SVG's own 100×100 viewBox.
 *
 * The same geometry the `clip-path` polygon described, in absolute units so the
 * stroke width does not scale with the box: `non-scaling-stroke` keeps it 1px at
 * any rendered size, which is what a hairline means.
 */
const SHIRT = "0,14 22,0 78,0 100,14 100,100 0,100";

/** A stable id per club, so two marks on one page cannot collide. */
const fillId = (code: string, kind: string) => `kit-${kind}-${code.toLowerCase()}`;

/**
 * The pattern as SVG paint.
 *
 * Stripes are a `<pattern>` rather than a repeating gradient because a pattern tiles
 * in the viewBox's units and therefore keeps its 3-unit rhythm however the mark is
 * sized. `plain` needs no def at all — its paint is the colour.
 */
function Paint({ kit }: { readonly kit: Kit }) {
  const a = kitTone(kit.primary);
  const b = kitTone(kit.secondary);
  if (kit.pattern === "stripes") {
    return (
      <pattern
        id={fillId(kit.code, "stripes")}
        width="12"
        height="12"
        patternUnits="userSpaceOnUse"
      >
        <rect width="12" height="12" fill={a} />
        <rect x="6" width="6" height="12" fill={b} />
      </pattern>
    );
  }
  if (kit.pattern === "sash") {
    return (
      <linearGradient id={fillId(kit.code, "sash")} x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stopColor={a} />
        <stop offset="38%" stopColor={a} />
        <stop offset="38%" stopColor={b} />
        <stop offset="58%" stopColor={b} />
        <stop offset="58%" stopColor={a} />
        <stop offset="100%" stopColor={a} />
      </linearGradient>
    );
  }
  return null;
}

const paintFor = (kit: Kit) =>
  kit.pattern === "plain"
    ? kitTone(kit.primary)
    : `url(#${fillId(kit.code, kit.pattern)})`;

export function KitMark({
  club,
  width = 15,
  height = 19,
  title,
}: {
  /** Three-letter code as `SquadPlayer.team` spells it. */
  readonly club: string | null | undefined;
  readonly width?: number;
  readonly height?: number;
  /** Overrides the spoken label; defaults to the club code. */
  readonly title?: string;
}) {
  const kit = kitFor(club);
  const label = kit
    ? title ?? kit.code
    : club ? `${club} — no kit defined` : "club unknown";

  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ display: "inline-block", flex: "0 0 auto" }}
    >
      <title>{label}</title>
      <defs>
        {kit ? <Paint kit={kit} /> : (
          /* An unknown code gets the app's own hatch rather than a grey box or a
             guessed colour — the same refusal every other absent value gets here.
             A promoted club missing from KITS must look missing, not invented. */
          <pattern id="kit-unknown" width="8" height="8" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(45)">
            <rect width="8" height="8" fill="transparent" />
            <rect width="4" height="8" fill="rgba(233,238,245,.14)" />
          </pattern>
        )}
      </defs>
      <polygon
        points={SHIRT}
        fill={kit ? paintFor(kit) : "url(#kit-unknown)"}
        // Fixed, not per-club: Villa's claret is 1.54:1 against the shell and
        // Newcastle's near-black 1.17:1, so without it those two are holes. The
        // stroke follows the polygon, so the shoulders are outlined too — which is
        // the whole reason this is not a bordered div.
        stroke={KIT_OUTLINE}
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default KitMark;
