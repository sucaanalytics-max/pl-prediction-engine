-- Private, backend-only snapshots for the personal FPL decision portal.
-- The service role is the only Data API role with access. RLS remains enabled
-- as defense in depth and there are intentionally no anon/authenticated policies.

create table if not exists public.fpl_manager_snapshots (
  id bigint generated always as identity primary key,
  snapshot_key text not null unique,
  entry_id bigint not null check (entry_id > 0),
  event_id integer not null check (event_id between 1 and 38),
  source text not null check (
    source in (
      'official_public',
      'captured_authenticated_draft',
      'stored_snapshot'
    )
  ),
  captured_at timestamptz not null,
  squad_value numeric(5, 1) not null check (squad_value >= 0),
  bank numeric(5, 1),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists fpl_manager_snapshots_entry_captured_idx
  on public.fpl_manager_snapshots (entry_id, captured_at desc);

alter table public.fpl_manager_snapshots enable row level security;
alter table public.fpl_manager_snapshots force row level security;

revoke all on table public.fpl_manager_snapshots from anon, authenticated;
revoke all on sequence public.fpl_manager_snapshots_id_seq from anon, authenticated;

grant select, insert, update, delete
  on table public.fpl_manager_snapshots
  to service_role;
grant usage, select
  on sequence public.fpl_manager_snapshots_id_seq
  to service_role;

comment on table public.fpl_manager_snapshots is
  'Backend-only snapshots for FPL entry 20945; never exposed to anon or authenticated clients.';
