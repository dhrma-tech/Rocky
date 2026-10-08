-- Typed event stream (UI spec "Agent UI", roadmap A10): what the UI renders work in flight from.
-- Separate from audit_log, which is the tamper-evident security record. Reversible:
-- 006_events.down.sql drops it again.
create table events (
  seq integer primary key autoincrement,
  at integer not null,
  kind text not null,
  run_id text,
  payload text not null
);
create index events_run on events (run_id, seq);
