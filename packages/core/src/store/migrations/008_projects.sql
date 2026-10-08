-- Projects (UI spec 12, docs/DECISIONS.md D-017, D-047): a name and a folder. The scope is a
-- project-kind notebook over that folder, so chat, briefs and retrieval reuse notebooks.
-- Reversible: 008_projects.down.sql.
create table projects (
  id text primary key,
  name text not null,
  folder text not null,
  notebook_id text references notebooks (id) on delete set null,
  created_at integer not null,
  archived_at integer
);
create unique index projects_folder on projects (folder) where archived_at is null;
