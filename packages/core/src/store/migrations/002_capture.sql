-- Phase 3: capture and understanding. Columns only (001 header: later phases add columns or indexes).

-- Job progress for GET /jobs/:id/events (0..1 plus a short note such as "mic 40%").
alter table jobs add column progress real;
alter table jobs add column progress_note text;

-- Meetings: where the audio came from, how long it is, the current job, the verbatim failure,
-- and the stored MeetingSummary JSON.
alter table meetings add column source text not null default 'recording'
  check (source in ('recording', 'import'));
alter table meetings add column duration_ms integer;
alter table meetings add column job_id text;
alter table meetings add column error text;
alter table meetings add column summary text;

-- Entities created from an extracted name stay unconfirmed until the user confirms or merges them.
alter table entities add column unconfirmed integer not null default 0;
create index entity_aliases_norm on entity_aliases (alias_norm);

-- The deadline as stated ("next Friday") when chrono-node can't turn it into a date, or alongside it.
alter table commitments add column deadline_text text;
create index decisions_document on decisions (source_document_id);
create index commitments_document on commitments (source_document_id);
