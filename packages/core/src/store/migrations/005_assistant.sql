-- Phase 6: assistant layer (briefs, routines, style profile).

-- Routines come from template packs (pack + template file) or are made in the UI (both null).
-- `prompt` is the user's edit; null means the template's prompt is used.
alter table routines add column pack text;
alter table routines add column template text;
alter table routines add column inputs text not null default '[]';
alter table routines add column prompt text;
alter table routines add column created_at integer;
create unique index routines_template on routines (pack, template) where pack is not null;

-- A run keeps its verified sentences (JSON AnswerSentence[]), the model path and any error.
alter table routine_runs add column output text;
alter table routine_runs add column not_found integer not null default 0;
alter table routine_runs add column error text;
alter table routine_runs add column path text;
alter table routine_runs add column usage text;
create index routine_runs_routine on routine_runs (routine_id, started_at);

create table briefs (
  id text primary key,
  kind text not null check (kind in ('event', 'notebook')),
  subject_id text not null,
  title text not null,
  starts_at integer,
  facts text not null default '[]',
  output text not null default '[]',
  not_found integer not null default 0,
  path text,
  created_at integer not null
);
create index briefs_subject on briefs (kind, subject_id, created_at);

-- Style exemplars quote sent mail; deleting any of these documents deletes the profile.
alter table style_profiles add column source_document_ids text not null default '[]';
