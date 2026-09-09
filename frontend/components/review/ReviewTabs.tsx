"use client";

/**
 * The two halves of /review, behind two tabs.
 *
 * ## Why tabs and not one scroll
 *
 * The page answers two questions — how is the season going, and what exactly
 * happened — and answering both in one scroll answers neither first. It also
 * does not survive the season: the detail grows by a handful of rows a week,
 * and by May a single page carries the whole record above the fold of nothing.
 *
 * ## Why an underline and not a pill
 *
 * The masthead already marks its active item with an underline, so a switch
 * that borrows the same device reads as navigation rather than as a filter.
 * 12px against the masthead's 11px keeps them siblings rather than twins.
 *
 * Both panels mount their own artifact, so a tab that has nothing to show says
 * so on its own rather than blanking the page.
 */
import { useState } from "react";
import ReviewDetail from "@/components/review/ReviewDetail";
import ReviewSummary from "@/components/review/ReviewSummary";
import { SIGNAL as S } from "@/lib/margin/tokens";

type Tab = "summary" | "detail";

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "detail", label: "Detailed data" },
];

export default function ReviewTabs() {
  const [tab, setTab] = useState<Tab>("summary");

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Review"
        style={{
          display: "flex",
          gap: 26,
          borderBottom: `1px solid ${S.rule}`,
        }}
      >
        {TABS.map(({ id, label }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`review-tab-${id}`}
              aria-selected={active}
              aria-controls={`review-panel-${id}`}
              data-testid={`review-tab-${id}`}
              onClick={() => setTab(id)}
              style={{
                // A real button, so the keyboard reaches it and the whole label
                // is the hit target rather than the text alone.
                appearance: "none",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${active ? S.ink : "transparent"}`,
                marginBottom: -1,
                padding: "0 0 10px",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: ".04em",
                color: active ? S.ink : S.ink3,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`review-panel-${tab}`}
        aria-labelledby={`review-tab-${tab}`}
      >
        {tab === "summary" ? <ReviewSummary /> : <ReviewDetail />}
      </div>
    </div>
  );
}
