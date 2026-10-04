# Spec: Notebooks and study mode

## Notebook = scope

```ts
interface Scope {
  documentIds?: string[];                    // manual adds
  rules?: {                                  // evaluated on ingest + nightly
    connectorIds?: string[];
    driveFolderIds?: string[];               // recursive
    notionPageIds?: string[];                // with descendants
    sourceTypes?: string[];
    tags?: string[];
    titleMatches?: string[];                 // e.g. course code "CS201"
    dateFrom?: number; dateTo?: number;
  };
  policy?: Partial<PolicyOverrides>;
}
```

- Rules are materialized into `notebook_sources` on ingest and nightly, which keeps retrieval filtering a cheap join. Manual adds and removals persist.
- Cross-notebook Ask = a union of scopes. Global Ask ignores notebooks.
- There's no source cap; the limit is hardware.
- `local_only` per notebook: the router treats any request whose scope touches the notebook as local-only. This includes cross-notebook queries: if any notebook in the union is local-only, the whole query is local-only.

## Course setup

Name, term, instructor, schedule (weekly slots), linked Drive folder or Notion page (becomes a rule), exam dates (manual + Calendar events matching `exam_tag`, default "exam"), and the "lecture capture defaults to this notebook during its scheduled slots" option.

## Verified cited chat

The same pipeline as Ask (assistant spec), scoped. The UI says "Answers are grounded in your sources" and shows the "Not in your sources" state prominently.

## Math routing

- The model emits `computations[{id, expr, purpose}]`. The daemon evaluates them with `mathjs` (`evaluate`, `simplify`, `derivative`, matrix ops, units) in a restricted instance: `import`, `createUnit` and `evaluate` re-entry are disabled, there's a 1 s timeout via worker, and the expression length cap is 500.
- Results are substituted for `{{calc:id}}` and shown with the expression.
- Unsupported operations (symbolic integrals, nonlinear solve) return a `not_computed` marker, rendered as "This step needs a computer algebra system; not computed." The number is never left for the LLM to guess.

## Study mode

### Flashcards (SM-2)

```ts
function sm2(card, q /* 0..5 */) {
  if (q < 3) { reps = 0; interval = 1; }
  else { reps += 1; interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ef); }
  ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  due = now + interval days;
}
// UI buttons: Again=1, Hard=3, Good=4, Easy=5
```

- Generation (`flashcard_gen`, local): from notebook chunks, 1–2 sentence answers. Each card has `source_chunk_id`. A card whose back is not supported by its chunk (quote check) is discarded.
- Review queue: cards due now across all notebooks or one notebook. New-card limit 20/day (configurable).

### Quizzes (answer-first)

1. Generate a question (and a hidden reference answer with citations) from the selected topics and difficulty.
2. The user answers in free text or multiple choice.
3. `quiz_grade` returns `{grade 0..1, feedback, citations}`. Feedback must cite. Arithmetic in grading goes through the math tool.
4. Store a `quiz_attempts` row.

### Topic weakness and exam countdown

- Topics come from document summaries' `topics` plus card topics, normalized per notebook.
- `weakness(topic) = Σ (1 - grade_i) * 0.5^(age_days_i / 7) / Σ 0.5^(age_days_i / 7)`. Untested topics get a prior of 0.5.
- Countdown view: days to exam, topics ranked by weakness × coverage weight, and a daily plan (N cards + 1 quiz on the top 2 weak topics).

## Summaries and study guides

Summary tree rollups: document → week (by `created_at` within the term) → notebook. A study guide = notebook or topic or date-range summary with sections per topic, every sentence cited (same verification). Export to Markdown, and to PDF via the browser print stylesheet.

## Mind map

`mindmap` task → `{nodes:[{id,label,chunkIds}], edges:[{from,to,label?}]}` with ≤ 60 nodes. Validation: every node has ≥ 1 chunk id within scope. Rendered with `@xyflow/react` plus dagre auto-layout. Clicking a node shows its citations.

## Exports

- **Anki CSV:** `front;back;tags` with semicolon delimiter and an `#separator:semicolon` header line. Tags = `rocky::<notebook>::<topic>`.
- **Study guide:** `.md` download; PDF via print.
- **Drive source pack:** one Google Doc per course per ISO week. HTML content (lecture summaries + transcript excerpts + key slides text, with source links) is uploaded with `mimeType: application/vnd.google-apps.document` into a designated folder, using `drive.file` scope only. It goes through the approval queue as one batch action. The UI explains that students can add this folder to Google's NotebookLM themselves. There is no NotebookLM API usage, official or unofficial.

## Optional: audio overview (only if Phase 9 has capacity)

Two-voice script from the study guide → `kokoro-js` local TTS → MP3 via ffmpeg. Marked optional.

## Academic integrity

- No "write my essay/assignment" templates. The student pack prompts are framed as explain, quiz and retrieve.
- Drafting is available for emails, not for coursework submission.
- UI copy keeps the "source-grounded study aid" framing.
