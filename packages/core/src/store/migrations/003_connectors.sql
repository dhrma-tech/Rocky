-- Phase 4: connector scheduling, a per-connector sync lock and a sync log.

alter table connectors add column interval_min integer;
alter table connector_state add column next_sync_at integer;
-- One sync per connector at a time (connectors.md "Runtime guarantees"); expires so a crash can't wedge it.
alter table connector_state add column lock_until integer;
-- ok | degraded | error | auth_expired, from the last sync or health check.
alter table connector_state add column last_status text;
alter table connector_state add column health_message text;
alter table connector_state add column consecutive_failures integer not null default 0;

create table connector_runs (
  id text primary key,
  connector_id text not null references connectors (id) on delete cascade,
  started_at integer not null,
  finished_at integer,
  status text not null check (status in ('running', 'ok', 'error')),
  added integer not null default 0,
  updated integer not null default 0,
  deleted integer not null default 0,
  requests integer not null default 0,
  full integer not null default 0,
  error text
);
create index connector_runs_by_connector on connector_runs (connector_id, started_at);
