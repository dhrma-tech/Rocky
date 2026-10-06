-- Phase 5: notebooks and study mode.

-- Record lectures into this notebook during its schedule slots.
alter table notebooks add column capture_default integer not null default 0;

-- Cards: when created and when first shown (the new-cards-per-day limit counts introductions).
alter table cards add column created_at integer;
alter table cards add column introduced_at integer;
-- The exact words from the source chunk that support the answer (shown with the citation).
alter table cards add column quote text;

-- Document summaries carry their topics (topic weakness and study guides group by them).
alter table summaries add column topics text not null default '[]';
create index summaries_document on summaries (document_id, level);
create index summaries_notebook on summaries (notebook_id, level);

-- One quiz has several questions; the reference answer is never sent to the student before grading.
create table quiz_questions (
  id text primary key,
  quiz_id text not null references quizzes (id) on delete cascade,
  question text not null,
  options text,
  reference text not null,
  topic text not null,
  chunk_ids text not null default '[]',
  created_at integer not null
);
create index quiz_questions_quiz on quiz_questions (quiz_id, created_at);
alter table quiz_attempts add column question_id text references quiz_questions (id) on delete cascade;
alter table quiz_attempts add column notebook_id text references notebooks (id) on delete cascade;
create index quiz_attempts_notebook on quiz_attempts (notebook_id, topic, attempted_at);
create index notebook_sources_document on notebook_sources (document_id);
