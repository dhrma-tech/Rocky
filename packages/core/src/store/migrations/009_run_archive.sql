-- Task history (UI spec 10): archiving hides a run from the history; the events stay (append-only).
-- Reversible: 009_run_archive.down.sql.
create table run_archive (
  run_id text primary key,
  archived_at integer not null
);
