-- Add a provenance value for a position the OWNER entered by hand.
--
-- The existing `captured_authenticated_draft` cannot be reused for this. It is a
-- fallback LABEL, set at frontend/lib/fpl-live-server.ts:521 by
-- `const source = picks ? "official_public" : "captured_authenticated_draft"` —
-- it means "FPL's official picks were unavailable, so this is a draft", and the
-- UI already renders it that way ("captured draft, not live",
-- frontend/components/SquadBoard.tsx:90).
--
-- "The owner typed this in" is a different and much stronger claim than "the API
-- would not tell us". Filing both under one label would make the screen say
-- something untrue about where a number came from, which this project treats as a
-- defect rather than a shortcut.
--
-- Drop-then-add rather than a guarded add: the original constraint is inline in
-- the CREATE TABLE, so it carries the generated name below. The pair is
-- re-runnable.

alter table public.fpl_manager_snapshots
  drop constraint if exists fpl_manager_snapshots_source_check;

alter table public.fpl_manager_snapshots
  add constraint fpl_manager_snapshots_source_check
  check (
    source in (
      'official_public',
      'captured_authenticated_draft',
      'stored_snapshot',
      'owner_captured'
    )
  );

comment on column public.fpl_manager_snapshots.source is
  'Provenance. official_public = FPL''s own picks endpoint. '
  'captured_authenticated_draft = official picks were unavailable. '
  'stored_snapshot = replayed from this table. '
  'owner_captured = the owner entered this position by hand; payload holds '
  'integer tenths of a million, matching pipeline EntryState, while the bank and '
  'squad_value columns hold millions for human and SQL use.';

-- No new index. The existing (entry_id, captured_at desc) index already leads with
-- the column a capture read filters on, and this table holds a handful of rows per
-- gameweek — an index chosen for a shape rather than for a measured cost is
-- machinery nobody will maintain.
