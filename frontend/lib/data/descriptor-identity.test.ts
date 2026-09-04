/**
 * A per-gameweek descriptor must have a per-gameweek identity.
 *
 * ## The production bug this closes, observed on pl2627.vercel.app 2026-09-04
 *
 * `/evidence` rendered GW1's minutes-conflicts while the rest of the page said
 * GW3 — sixteen conflicts from an artifact written before the `evidence_feed`
 * field existed, so the new staleness warning was invisible too.
 *
 * The mechanism is `useArtifact`'s in-flight coalescing, which keys on
 * `identityOf(descriptor) = descriptor.key` and states plainly that it is keyed
 * on identity "never its path". `minutesConflictsDescriptor(gw)` spread a shared
 * shape and overrode only `path`, so every gameweek shared the key
 * `"minutesConflicts"`. `MinutesConflicts` resolves its week as
 * `gameweek ?? shared ?? 1`, so on a cold load it starts a fetch for **gw01**
 * under that key; when the real week resolves to 3 the second call finds the
 * in-flight entry and is handed **gw01's promise**. The path in the effect's
 * deps could not save it — the collision happens after the effect re-runs.
 *
 * `projectionsDescriptor` and `decisionDescriptor` already scope their keys
 * (`projections:03`, `decision:03`). This was the one outlier, which is why a
 * test over all three is worth more than fixing the one: the convention existed
 * and nothing enforced it.
 */
import { describe, expect, it } from "vitest";

import { minutesConflictsDescriptor } from "@/lib/data/minutes-conflicts";
import { projectionsDescriptor } from "@/lib/data/projections";
import { decisionDescriptor } from "@/lib/data/narrow";

const FACTORIES: Record<string, (gw: number) => { key: string; path: string }> = {
  minutesConflictsDescriptor,
  projectionsDescriptor,
  decisionDescriptor,
};

describe("per-gameweek descriptors", () => {
  for (const [name, make] of Object.entries(FACTORIES)) {
    it(`${name} gives different gameweeks different keys`, () => {
      const one = make(1);
      const three = make(3);
      expect(one.path).not.toEqual(three.path);
      // The load layer coalesces on key alone. Equal keys with unequal paths is
      // precisely the state that serves one gameweek's payload for another's.
      expect(one.key).not.toEqual(three.key);
    });

    it(`${name} keeps key and path in step across a range`, () => {
      const keys = new Set<string>();
      const paths = new Set<string>();
      for (let gw = 1; gw <= 38; gw += 1) {
        const d = make(gw);
        keys.add(d.key);
        paths.add(d.path);
      }
      expect(keys.size).toBe(38);
      expect(paths.size).toBe(38);
    });
  }
});
