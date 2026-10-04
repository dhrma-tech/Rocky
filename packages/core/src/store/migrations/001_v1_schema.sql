-- Rocky V1 schema. Spec: docs/specs/memory.md. Later phases only add indexes or columns.
-- IDs are TEXT ULIDs; timestamps are INTEGER ms UTC.

create table documents (
  id text primary key,
  connector_id text,
  external_id text,
  source_type text not null,
  mime text,
  uri text,
  title text not null default '',
  author_entity_id text,
  created_at integer,
  updated_at integer,
  ingested_at integer not null,
  raw_text text not null default '',
  content_hash text not null,
  meta text not null default '{}',
  blob_hash text,
  suspicious integer not null default 0,
  local_only integer not null default 0,
  unique (connector_id, external_id)
);
create index documents_source_updated on documents (source_type, updated_at);
create index documents_hash on documents (content_hash);

-- seq is the stable integer key used by chunks_fts and chunks_vec (a bare rowid can change on VACUUM).
create table chunks (
  seq integer primary key,
  id text not null unique,
  document_id text not null references documents (id) on delete cascade,
  ord integer not null,
  text text not null,
  token_count integer not null,
  char_start integer not null,
  char_end integer not null,
  anchor text not null,
  section_path text,
  summary_id text
);
create index chunks_doc_ord on chunks (document_id, ord);

-- Contentless: rowid = chunks.seq. Rows are inserted and deleted explicitly by ingest/deletion.
create virtual table chunks_fts using fts5 (
  text, title,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- vec0 does not cascade: ingest and DeletionService delete these rows explicitly.
create virtual table chunks_vec using vec0 (
  chunk_seq integer primary key,
  embedding float[768] distance_metric=cosine,
  source_type text,
  created_at integer
);

create table summaries (
  id text primary key,
  level text not null check (level in ('document', 'notebook_week', 'notebook', 'topic')),
  scope_key text,
  document_id text references documents (id) on delete cascade,
  notebook_id text references notebooks (id) on delete cascade,
  text text not null,
  child_chunk_ids text not null default '[]',
  child_summary_ids text not null default '[]',
  model text,
  created_at integer not null
);

create table entities (
  id text primary key,
  kind text not null check (kind in ('person', 'org', 'course', 'project')),
  display_name text not null,
  primary_email text,
  meta text not null default '{}'
);
create table entity_aliases (
  entity_id text not null references entities (id) on delete cascade,
  alias text not null,
  alias_norm text not null,
  unique (alias_norm, entity_id)
);
create table document_entities (
  document_id text not null references documents (id) on delete cascade,
  entity_id text not null references entities (id) on delete cascade,
  role text not null,
  primary key (document_id, entity_id, role)
);

create table commitments (
  id text primary key,
  text text not null,
  owner_entity_id text references entities (id) on delete set null,
  counterparty_entity_id text references entities (id) on delete set null,
  deadline integer,
  status text not null check (status in ('open', 'done', 'dropped', 'waiting')),
  source_document_id text not null references documents (id) on delete cascade,
  anchor text not null,
  evidence_quote text not null,
  confidence real,
  user_edited integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create index commitments_status_deadline on commitments (status, deadline);
create index commitments_owner on commitments (owner_entity_id);

create table decisions (
  id text primary key,
  text text not null,
  owner_entity_id text references entities (id) on delete set null,
  decided_at integer,
  source_document_id text not null references documents (id) on delete cascade,
  anchor text not null,
  evidence_quote text not null,
  created_at integer not null
);

create table notebooks (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('course', 'project', 'research')),
  term text,
  instructor text,
  schedule text not null default '{}',
  scope text not null default '{}',
  exam_dates text not null default '[]',
  exam_tag text,
  local_only integer not null default 0,
  created_at integer not null
);
create table notebook_sources (
  notebook_id text not null references notebooks (id) on delete cascade,
  document_id text not null references documents (id) on delete cascade,
  added_by text not null check (added_by in ('rule', 'manual')),
  primary key (notebook_id, document_id)
);

create table meetings (
  id text primary key,
  document_id text not null unique references documents (id) on delete cascade,
  title text not null,
  started_at integer,
  ended_at integer,
  kind text not null check (kind in ('meeting', 'lecture')),
  notebook_id text references notebooks (id) on delete set null,
  audio_blob text,
  consent_logged_at integer,
  transcription_status text,
  calendar_event_external_id text
);
create table transcript_segments (
  id text primary key,
  meeting_id text not null references meetings (id) on delete cascade,
  start_ms integer not null,
  end_ms integer not null,
  channel text not null check (channel in ('mic', 'system', 'mixed')),
  speaker_label text,
  text text not null,
  avg_logprob real
);
create index transcript_segments_meeting on transcript_segments (meeting_id, start_ms);

create table cards (
  id text primary key,
  notebook_id text not null references notebooks (id) on delete cascade,
  front text not null,
  back text not null,
  source_chunk_id text,
  topic text,
  ef real not null default 2.5,
  interval_days integer not null default 0,
  repetitions integer not null default 0,
  due_at integer,
  suspended integer not null default 0
);
create index cards_notebook_due on cards (notebook_id, due_at);
create table card_reviews (
  id text primary key,
  card_id text not null references cards (id) on delete cascade,
  reviewed_at integer not null,
  rating integer not null,
  prev_interval integer,
  new_interval integer,
  prev_ef real,
  new_ef real
);
create table quizzes (
  id text primary key,
  notebook_id text not null references notebooks (id) on delete cascade,
  topic_filter text not null default '[]',
  difficulty text,
  created_at integer not null
);
create table quiz_attempts (
  id text primary key,
  quiz_id text not null references quizzes (id) on delete cascade,
  question text not null,
  user_answer text,
  grade real,
  feedback text,
  citations text not null default '[]',
  topic text,
  attempted_at integer not null
);
create index quiz_attempts_topic on quiz_attempts (topic, attempted_at);

create table routines (
  id text primary key,
  name text not null,
  template_ref text,
  schedule_cron text,
  enabled integer not null default 0,
  params text not null default '{}',
  last_run_at integer
);
create table routine_runs (
  id text primary key,
  routine_id text not null references routines (id) on delete cascade,
  started_at integer not null,
  finished_at integer,
  status text not null,
  output_document_id text
);

create table actions_queue (
  id text primary key,
  connector_id text,
  action_type text not null,
  payload text not null,
  payload_hash text not null,
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null check (status in ('draft', 'approved', 'rejected', 'executing', 'executed', 'failed')),
  origin text not null,
  citations text not null default '[]',
  idempotency_key text not null unique,
  approved_hash text,
  approved_at integer,
  result text,
  error text,
  created_at integer not null,
  updated_at integer not null
);
create index actions_status_created on actions_queue (status, created_at);

create table audit_log (
  seq integer primary key autoincrement,
  at integer not null,
  event_type text not null,
  actor text not null check (actor in ('user', 'routine', 'system')),
  subject_type text,
  subject_id text,
  payload_hash text,
  meta text not null default '{}',
  prev_hash text not null,
  row_hash text not null
);
create trigger audit_log_no_update before update on audit_log
begin
  select raise(abort, 'audit_log is append-only');
end;
create trigger audit_log_no_delete before delete on audit_log
begin
  select raise(abort, 'audit_log is append-only');
end;
create table audit_payloads (
  payload_hash text primary key,
  body text not null
);

create table connectors (
  id text primary key,
  kind text not null,
  display_name text not null,
  enabled integer not null default 1,
  read_only integer not null default 1,
  config text not null default '{}',
  created_at integer not null
);
create table connector_state (
  connector_id text primary key references connectors (id) on delete cascade,
  cursor text,
  last_sync_at integer,
  last_success_at integer,
  last_error text,
  backoff_until integer
);

create table usage_log (
  id text primary key,
  at integer not null,
  task text not null,
  provider text not null,
  model text not null,
  local integer not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real not null default 0,
  fallback_reason text,
  scope_key text
);
create index usage_log_at on usage_log (at);

create table jobs (
  id text primary key,
  type text not null,
  payload text not null default '{}',
  status text not null check (status in ('queued', 'running', 'done', 'failed')),
  priority integer not null default 0,
  heavy integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after integer not null,
  last_error text,
  created_at integer not null,
  updated_at integer not null
);
create index jobs_ready on jobs (status, priority, run_after);

create table settings (
  key text primary key,
  value text not null
);

create table style_profiles (
  id text primary key,
  channel text not null check (channel in ('email', 'chat')),
  descriptor text not null,
  exemplars text not null default '[]',
  updated_at integer not null
);

-- Additions beyond memory.md (Phase 1 plan): conversation history and watched folders.
create table conversations (
  id text primary key,
  title text not null default '',
  scope text not null default '{}',
  created_at integer not null,
  updated_at integer not null
);
create table conversation_turns (
  id text primary key,
  conversation_id text not null references conversations (id) on delete cascade,
  ord integer not null,
  question text not null,
  answer text not null,
  created_at integer not null
);
create index conversation_turns_conv on conversation_turns (conversation_id, ord);

create table watched_folders (
  id text primary key,
  path text not null unique,
  recursive integer not null default 1,
  enabled integer not null default 1,
  created_at integer not null
);
