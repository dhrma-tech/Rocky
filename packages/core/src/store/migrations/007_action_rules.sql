-- Rules and grants (roadmap A4) and approve-then-hold (docs/DECISIONS.md D-014).
-- Reversible: 007_action_rules.down.sql.
alter table actions_queue add column execute_after integer;
alter table actions_queue add column approved_by_rule text;
create index actions_execute_after on actions_queue (status, execute_after);

create table action_rules (
  id text primary key,
  effect text not null check (effect in ('allow', 'ask', 'block')),
  connector_id text,
  action_type text,
  action_class text check (action_class in ('write', 'send', 'spend', 'delete')),
  constraints text not null default '[]',
  -- Required for allow (checked in code): no blanket "always allow" (roadmap X4).
  expires_at integer,
  uses_left integer,
  from_action_id text,
  note text not null default '',
  created_at integer not null,
  revoked_at integer
);
create index action_rules_active on action_rules (revoked_at, expires_at);
