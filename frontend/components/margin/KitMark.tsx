/**
 * An abstracted shirt: two colours, a pattern, and a shoulder notch.
 *
 * Recovered with `lib/margin/kits.ts` — see that file for why the club is worth a
 * hue at all, and why no lettering appears on it.
 *
 * The notch is what makes 15×19px read as a shirt rather than as a colour chip, and
 * it is the entire silhouette budget: one `clip-path`, no crest, no sponsor, no
 * sleeves, no render, no network request. Nothing here is licensed.
 *
 * ## It is never the only thing saying which club
 *
 * Ten club pairs remain indistinguishable after colour and pattern — Liverpool and
 * Man United are both plain reds, as they are in life. So the mark carries an
 * `aria-label` and the row keeps its three-letter code. A reader who cannot tell
 * two shirts apart has lost nothing; a reader who can has saved a comparison.
 */
import { kitBackground, kitFor, KIT_OUTLINE } from "@/lib/margin/kits";

/** The shoulder line. Cheap, and the only thing saying "shirt". */
const SHIRT = "polygon(0 14%, 22% 0, 78% 0, 100% 14%, 100% 100%, 0 100%)";

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

  // An unknown code gets the app's own hatch rather than a grey box or a guessed
  // colour — the same refusal every other absent value gets here. A promoted club
  // missing from KITS must look missing, not invented.
  if (!kit) {
    return (
      <span
        role="img"
        aria-label={club ? `${club} — no kit defined` : "club unknown"}
        title={club ? `${club} — no kit defined` : "club unknown"}
        style={{
          display: "inline-block",
          width,
          height,
          clipPath: SHIRT,
          background:
            "repeating-linear-gradient(45deg, rgba(233,238,245,.14) 0 2px, transparent 2px 4px)",
          border: `1px solid ${KIT_OUTLINE}`,
          flex: "0 0 auto",
        }}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={title ?? kit.code}
      title={title ?? kit.code}
      style={{
        display: "inline-block",
        width,
        height,
        clipPath: SHIRT,
        background: kitBackground(kit),
        // Fixed, not per-club: Villa's claret is 1.54:1 against the shell and
        // Newcastle's near-black 1.17:1, so without it those two are holes.
        border: `1px solid ${KIT_OUTLINE}`,
        flex: "0 0 auto",
      }}
    />
  );
}

export default KitMark;
