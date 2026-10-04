# Spec: Memory (store, ingest, retrieval)

## Store

- SQLite via better-sqlite3 (13.x, N-API). WAL mode, `foreign_keys=ON`, `busy_timeout=5000`.
- One DB file `rocky.db` in the data dir. Large blobs (audio, original files) live on disk under `blobs/<sha256>`, with only the path in the DB.

### Migrations

- Files: `packages/core/src/store/migrations/NNN_name.sql`. Forward-only.
- `PRAGMA user_version` holds the applied number.
- Each migration runs in one transaction, after the DB is copied to `backups/rocky-<ver>-<ts>.db`. The last 3 backups are kept.
- Migration 001 contains the whole V1 schema, so later phases only add indexes or columns.

### Tables

Types are abbreviated. All `id` columns are TEXT ULIDs. All timestamps are INTEGER ms UTC.

```
documents(id PK, connector_id, external_id, source_type, mime, uri, title, author_entity_id,
          created_at, updated_at, ingested_at, raw_text, content_hash, meta JSON,
          suspicious INT DEFAULT 0, local_only INT DEFAULT 0,
          UNIQUE(connector_id, external_id))
  idx: (source_type, updated_at), (content_hash)

chunks(id PK, document_id FK→documents ON DELETE CASCADE, ord, text, token_count,
       char_start, char_end, anchor JSON, section_path, summary_id NULL)
  idx: (document_id, ord)
chunks_fts  FTS5(text, title, content='chunks', content_rowid=rowid, tokenize='unicode61 remove_diacritics 2')
chunks_vec  vec0(chunk_rowid INTEGER PRIMARY KEY, embedding float[768],
                 source_type TEXT, created_at INTEGER)      -- metadata columns for pre-filter
  -- vec0 does not cascade: DeletionService deletes vec rows explicitly before chunks.

summaries(id PK, level TEXT CHECK(level IN ('document','notebook_week','notebook','topic')),
          scope_key, document_id NULL FK CASCADE, notebook_id NULL FK CASCADE,
          text, child_chunk_ids JSON, child_summary_ids JSON, model, created_at)

entities(id PK, kind CHECK(kind IN ('person','org','course','project')), display_name,
         primary_email NULL, meta JSON)
entity_aliases(entity_id FK CASCADE, alias, alias_norm, UNIQUE(alias_norm, entity_id))
document_entities(document_id FK CASCADE, entity_id FK CASCADE, role, PRIMARY KEY(document_id, entity_id, role))

commitments(id PK, text, owner_entity_id NULL, counterparty_entity_id NULL, deadline NULL,
            status CHECK(status IN ('open','done','dropped','waiting')), source_document_id FK CASCADE,
            anchor JSON, evidence_quote, confidence REAL, user_edited INT, created_at, updated_at)
  idx: (status, deadline), (owner_entity_id)
decisions(id PK, text, owner_entity_id NULL, decided_at, source_document_id FK CASCADE,
          anchor JSON, evidence_quote, created_at)

meetings(id PK, document_id FK CASCADE UNIQUE, title, started_at, ended_at, kind CHECK(kind IN ('meeting','lecture')),
         notebook_id NULL, audio_blob, consent_logged_at, transcription_status, calendar_event_external_id NULL)
transcript_segments(id PK, meeting_id FK CASCADE, start_ms, end_ms, channel CHECK(channel IN ('mic','system','mixed')),
                    speaker_label, text, avg_logprob REAL)
  idx: (meeting_id, start_ms)

notebooks(id PK, name, kind CHECK(kind IN ('course','project','research')), term, instructor,
          schedule JSON, scope JSON, exam_dates JSON, exam_tag, local_only INT DEFAULT 0, created_at)
notebook_sources(notebook_id FK CASCADE, document_id FK CASCADE, added_by CHECK(added_by IN ('rule','manual')),
                 PRIMARY KEY(notebook_id, document_id))       -- materialized from scope rules + manual adds

cards(id PK, notebook_id FK CASCADE, front, back, source_chunk_id NULL, topic,
      ef REAL DEFAULT 2.5, interval_days INT DEFAULT 0, repetitions INT DEFAULT 0, due_at, suspended INT DEFAULT 0)
  idx: (notebook_id, due_at)
card_reviews(id PK, card_id FK CASCADE, reviewed_at, rating INT, prev_interval, new_interval, prev_ef, new_ef)
quizzes(id PK, notebook_id FK CASCADE, topic_filter JSON, difficulty, created_at)
quiz_attempts(id PK, quiz_id FK CASCADE, question, user_answer, grade REAL, feedback, citations JSON, topic, attempted_at)
  idx: (topic, attempted_at)

routines(id PK, name, template_ref, schedule_cron, enabled INT, params JSON, last_run_at)
routine_runs(id PK, routine_id FK CASCADE, started_at, finished_at, status, output_document_id NULL)

actions_queue(id PK, connector_id, action_type, payload JSON, payload_hash, risk CHECK(risk IN ('low','medium','high')),
              status CHECK(status IN ('draft','approved','rejected','executing','executed','failed')),
              origin, citations JSON, idempotency_key UNIQUE, approved_hash NULL, approved_at NULL,
              result JSON NULL, error NULL, created_at, updated_at)
  idx: (status, created_at)
audit_log(seq INTEGER PK AUTOINCREMENT, at, event_type, actor CHECK(actor IN ('user','routine','system')),
          subject_type, subject_id, payload_hash NULL, meta JSON, prev_hash, row_hash)
  triggers: BEFORE UPDATE / BEFORE DELETE → RAISE(ABORT,'audit_log is append-only')
audit_payloads(payload_hash PK, body JSON)                   -- purgeable; chain covers the hash only

connectors(id PK, kind, display_name, enabled, read_only INT, config JSON, created_at)
connector_state(connector_id PK FK CASCADE, cursor JSON, last_sync_at, last_success_at, last_error, backoff_until)
usage_log(id PK, at, task, provider, model, local INT, input_tokens, output_tokens, cost_usd REAL,
          fallback_reason NULL, scope_key NULL)
  idx: (at)
jobs(id PK, type, payload JSON, status CHECK(status IN ('queued','running','done','failed')),
     priority INT, heavy INT, attempts INT, run_after, last_error, created_at)
  idx: (status, priority, run_after)
settings(key PK, value JSON)
style_profiles(id PK, channel CHECK(channel IN ('email','chat')), descriptor, exemplars JSON, updated_at)
```

## Ingest pipeline

`connector/import → Document → parse → chunk → upsert → enqueue(embed) → enqueue(summarize-doc) → enqueue(understand)` (the last only for meetings, email threads and notes).

- **Upsert:** if `content_hash` is unchanged, skip. If it changed, delete the old chunks and vec rows and re-chunk. Derived commitments with `user_edited=1` are kept and re-linked.
- **Parsers:**
  - PDF: `pdfjs-dist`, per-page text with char offsets.
  - DOCX: `mammoth` to HTML to text with headings.
  - MD/TXT.
  - HTML: strip to text with headings.
  - Google Docs: exported text.
- **Chunker:**
  1. Split on structure (headings → paragraphs → sentences).
  2. Pack to ~350 tokens (hard cap 900), with 15% overlap **within** an anchor unit only.
  3. Units that never get merged: PDF page, email message, Notion block group under one heading, a transcript window of ≤ 60 s, a GitHub issue body or comment, a calendar event, a data-source row.
- **Embeddings:** `nomic-embed-text` via Ollama `/api/embed`, batch size 32. Prefixes `search_document: ` / `search_query: ` (required by nomic). The dimension is stored in settings; changing the model triggers a re-embed job.

## Retrieval

```
retrieve(query, scope, k=10):
  q_fts  = FTS5 MATCH (sanitized query; OR of terms + phrase boost) → top 50 by bm25(chunks_fts, 1.0, 0.3)
  q_vec  = vec0 KNN(embed("search_query: "+query), k = scope.isNarrow ? 200 : 50)
           WHERE source_type/created_at metadata filters
  apply scope filter (join notebook_sources / documents) to both lists
  fused  = RRF: score(d) = Σ 1/(60 + rank_i(d))   → top 20
  rerank = Reranker.rerank(query, fused)          // no-op in V1
  select = greedy by score, max 3 chunks/document (unless single-doc scope), token budget 4k (API) / 2.5k (local)
```

- **Broad-question detection:** the router's `classify` task, or heuristics ("summarize", "overview", "everything about", "what did we cover"). For these, retrieve summary nodes first, then their top child chunks.
- **Scope:** `{ notebookIds?, connectorIds?, sourceTypes?, entityIds?, dateFrom?, dateTo?, documentIds?, tags? }`. A union of notebooks equals cross-notebook search.

## Anchor resolution

`GET /api/v1/documents/:id/anchor?chunk=…` returns a viewer payload:
- `pdf`: blob URL + page + highlight rects (computed client-side by pdf.js text layer search for the quote).
- `text`: raw text + char range.
- `transcript`: audio URL + `startMs`.
- `external`: deep link (Gmail thread URL, Notion block URL with `#blockId`, GitHub issue/comment URL, Notion Calendar deep link).

## Deletion

`DeletionService.delete({ documentIds | connectorId | notebookId(+withSources?) | all })` runs in one transaction:
1. Collect chunk rowids → delete `chunks_vec` rows → delete `chunks_fts` rows (external-content delete command) → delete documents (cascades).
2. Delete orphaned summaries.
3. Purge `audit_payloads` whose hashes are referenced only by the deleted subjects.
4. Remove blobs.
5. Append an audit event `deleted` with IDs and counts.

"Delete everything" removes the DB file, blobs, backups, and Rocky keychain entries after typed confirmation.
