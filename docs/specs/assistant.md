# Spec: Assistant (Ask, understanding, briefs, routines, drafts, timeline)

## Ask with sources

```
POST /api/v1/ask  { question, scope?, showFlagged?, conversationId? }  → SSE events:
  retrieval {chunks:[{id, docTitle, anchor}]}
  draft_sentence {i, text, citations}          // streamed as generated
  verified {i, status: supported|partial|unsupported, quote}
  computation {expr, result}                    // mathjs
  done {answer: Sentence[], notFound: bool, path: PathInfo, usage}
```

### Answer schema (structured output)

```ts
{ sentences: { text: string; citations: string[]; quote: string }[];
  computations?: { id: string; expr: string; purpose: string }[];   // referenced in text as {{calc:id}}
  notFound: boolean }
```

### Prompt rules

- Answer only from `<untrusted_data>` chunks.
- Every factual sentence cites ≥ 1 chunk id and copies a verbatim `quote` of ≤ 40 words.
- Transitional sentences are allowed only without facts.
- If the chunks are insufficient, `notFound: true`.
- Never compute numbers yourself. Emit `computations`.

### Verification

1. **Quote check (deterministic):** normalize whitespace, quotes and dashes, and lowercase. `quote` must be a substring of one of the cited chunks. Fail → UNSUPPORTED.
2. **Verifier** (`verify` task, batched per answer): for each sentence plus its quote, label SUPPORTED / PARTIAL / UNSUPPORTED with a one-line reason.
3. **Render:** SUPPORTED is shown. PARTIAL is shown with a "partially supported" marker. UNSUPPORTED is removed, or struck through if `showFlagged`. If zero sentences remain, the answer is "Not found in your sources." with the top 3 retrieved sources listed as "closest matches".

## Understanding (extraction)

The `understand` job runs on meetings, email threads, Notion pages with action-item blocks, and GitHub issues.

```ts
Commitment { text; owner: string /*name or "me"*/; counterparty?: string; deadline?: string /*as stated*/;
             evidenceQuote; segmentRef /*chunk id or segment id*/; confidence: number }
Decision   { text; owner?; evidenceQuote; segmentRef }
Entity     { name; kind: 'person'|'org'|'course'|'project'; email?; mentions: string[] }
MeetingSummary { title; summary: string /*≤ 200 words*/; topics: string[]; openQuestions: string[] }
```

### Validation pipeline

1. zod parse.
2. `evidenceQuote` must be a substring of the referenced segment.
3. `deadline` goes through `chrono-node` with the document date as reference. Unparseable → kept as text with `deadline=null`.
4. Owner names are resolved to entities: email exact match, then alias_norm, else a new entity flagged `unconfirmed`. "me"/"I" in the mic channel maps to the user's entity.
5. Errors → 1 repair retry with the error list → escalate per policy → else job `failed` with a visible reason.

Dedup: same owner + Jaccard(text) > 0.7 + same deadline day → merge, keeping both anchors.

Long transcripts (> 12k tokens) are chunked into windows, extracted per window, then merged.

## Briefs

`brief(eventId | notebookId+date)` collects:
- the event (attendees → entities)
- the last 3 documents involving those entities
- open commitments involving them
- open questions from previous meetings in the same series (by recurring event id or title similarity)
- for classes: the notebook's last lecture summary, due items, and exam countdown

Generated with `routine` task policy. Cited like Ask (same verification).

## Routines

- Templates are files in `templates/<pack>/routines/*.yaml`:
  ```yaml
  name: Morning brief
  schedule: "0 7 * * 1-5"
  inputs: [calendar_today, commitments_due_7d, overdue, unread_important_threads]
  prompt: prompts/morning-brief.md
  output: { document: true, notify: ui }
  ```
- `origin = routine:<id>`. Routines may **propose** actions (queued), never execute them.
- Missed runs (machine asleep) catch up once.

## Drafting in the user's voice

- **Style profile job:** sample ≤ 200 sent emails (`in:sent`), extract a descriptor (greeting/sign-off habits, length, formality, language mix) plus 5 exemplars. Stored in `style_profiles`. Refreshed monthly.
- `draft` task input: the thread (untrusted-wrapped), relevant memory chunks, the style descriptor and exemplars, and the user's instruction. Output `{to, cc, subject, body, citations}` → action proposal `gmail.draftCreate` → queue. Executed only on approval, and the result is a Gmail **draft**.
- Slack: the same flow, but the "executor" only marks the draft ready and shows copy + deep link.

## Action proposals from content

`propose_actions` (API, `origin=user_turn`): input = the user's request + the source document. Output = `ActionProposal[]` (≤ 10), each with `citations`. Types are restricted to those implied by the request (see SECURITY.md). All go to the queue as `draft`.

## Unified timeline

`GET /api/v1/timeline?from&to` merges, normalized to `{kind, title, start, end?, due?, source, deepLink, documentId}`:
- Google Calendar events and CalDAV events
- Todoist / Asana / Linear / GitHub items with due dates
- Notion data-source rows with a date property
- commitments with deadlines

Deduplicated by (title similarity, same time) across Google Calendar and CalDAV.

## Template packs

```
templates/<pack>/pack.yaml          # name, segment, description, recommended connectors
templates/<pack>/prompts/*.md       # frontmatter: task, inputs; body: prompt with {{vars}}
templates/<pack>/routines/*.yaml
```

Packs: `student`, `founder-ops`, `product-eng`. User overrides go in `<datadir>/templates/` and win over the shipped files.
