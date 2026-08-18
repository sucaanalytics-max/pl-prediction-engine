/**
 * An abstracted shirt: two colours, a pattern, and a shoulder notch.
 *
 * ONE component with one `mute` parameter driven by the surface — deliberately not
 * two components. The geometry is identical on paper and ink; only the fill differs,
 * and expressing that as a parameter keeps the two surfaces from drifting apart the
 * first time the notch or the border changes.
 *
 * The notch is what makes 15×19px read as a shirt rather than as a colour chip. It
 * is the whole silhouette budget: no crest, no sponsor, no sleeves, no render. See
 * `kits.ts` for why that is a correctness decision and not a shortcut.
 */
import { KITS, kitBackground, type Kit } from "@/components/squad/kits";
import {
  KIT_MIX_TARGET, surfaceIsLight, type MarginSurface,
} from "@/lib/margin/tokens";

/** The shoulder line. Cheap, and the only thing saying "shirt". */
const SHIRT = "polygon(0 14%, 22% 0, 78% 0, 100% 14%, 100% 100%, 0 100%)";

export function KitMark({
  club, surface, mute, width = 15, height = 19,
}: {
  /** Three-letter code as the artifacts spell it. */
  club: string;
  surface: MarginSurface;
  /**
   * Mute toward the paper tint. Defaults to "whenever the surface is a light one",
   * which is the only rule any caller has needed — passed explicitly only by the
   * tests that assert the two calibrations differ.
   */
  mute?: boolean;
  width?: number;
  height?: number;
}) {
  const kit: Kit | undefined = KITS[club];
  // Measured, not matched against PAPER's literal: a club colour is mixed toward a
  // light ground so fifteen marks land in one lightness band, and on a dark ground it
  // is already reading against the dark and must keep its full strength — which is what
  // makes six league reds tell each other apart.
  const muted = mute ?? surfaceIsLight(surface);

  // An unknown code gets the hatch, not a grey box and not a guess. A club we have
  // no entry for is a fact about this table, and `∅`-style honesty applies to a
  // mark as much as to a figure.
  if (!kit) {
    return (
      <span
        role="img"
        aria-label={`${club} — no kit defined`}
        title={`${club} — no kit is defined for this club`}
        style={{
          width, height, flexShrink: 0, display: "inline-block",
          clipPath: SHIRT,
          border: `1px solid ${surface.hair}`,
          backgroundImage:
            `repeating-linear-gradient(45deg, ${surface.ink3} 0 3px, transparent 3px 6px)`,
        }}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={`${club} kit`}
      title={club}
      data-club={club}
      data-pattern={kit.pattern}
      data-muted={muted ? "true" : "false"}
      style={{
        width, height, flexShrink: 0, display: "inline-block",
        clipPath: SHIRT,
        border: `1px solid ${surface.hair}`,
        background: kitBackground(kit, muted, KIT_MIX_TARGET),
      }}
    />
  );
}
