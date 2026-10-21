-- Notifications (UI spec 16): derived from the event stream by the notifier, one row per event at
-- most. The cursor row in notifier_state records the last event looked at, so nothing is derived
-- twice across restarts. Reversible: 010_notifications.down.sql.
create table notifications (
  id text primary key,
  at integer not null,
  kind text not null check (kind in ('needs_you', 'update', 'heads_up', 'system')),
  sentence text not null,
  link text,
  action_label text not null,
  run_id text,
  event_seq integer unique,
  read_at integer,
  snoozed_until integer,
  dismissed_at integer
);
create index notifications_at on notifications (at);
create index notifications_unread on notifications (read_at, dismissed_at);

create table notifier_state (
  id integer primary key check (id = 1),
  last_seq integer not null
);
