# Demo script (about 4 minutes)

A walkthrough that shows what Rocky does differently: cited answers, approval before any write, and memory that other tools can use. Everything runs on one laptop. Times are for a CPU-only machine with an Anthropic key stored; with `--local-only` answers take a minute or two each, so pre-record those parts.

## Before you start

```sh
pnpm rocky --data-dir E:\RockyDemo ingest evals/public/corpus
pnpm rocky --data-dir E:\RockyDemo daemon
pnpm rocky --data-dir E:\RockyDemo open        # sign in once in the browser
```

Use a fresh data dir so the demo shows only sample data. The public corpus is fictional and licensed for this (see `evals/public/ATTRIBUTION.md`).

## 1. Ask, with sources (60 s)

- Web UI → **Ask**: "What did the team decide in the 14 September sync?"
- Point out: each sentence has numbered citations; clicking one opens the transcript at the timestamp, or the PDF at the page, with the passage highlighted.
- Ask something the corpus does not cover: "What is our hiring budget for next year?" Rocky answers **"Not found in your sources"** and lists the closest documents. Say: it would rather say nothing than guess.

## 2. Local-only (20 s)

- Settings → turn on **Local only**, then ask again. The model line under Ask changes to "Local models" and the answer shows the local path. Or in a terminal: `pnpm rocky ask --local-only "…"`. Say: in local-only mode no model call leaves the machine; the gate blocks it, it is not a hint the model can ignore.

## 3. A lecture becomes a notebook (60 s)

- **Notebooks** → the ECON 101 notebook (or create one with the lecture notes PDF as a source).
- Show the cited study guide, then **Quiz**: answer one question badly on purpose; the grade comes with the reference answer and its citation.
- Show **Flashcards** due today and the exam countdown.

## 4. Nothing runs without approval (60 s)

- Ask: "Turn the action items from the 14 September sync into tasks." Rocky proposes actions instead of doing anything.
- **Actions**: open one draft. Show the exact payload, the cited source and the risk level. Edit a field: the payload hash changes, and approval binds to the payload you see at that moment.
- Approve, then show **Audit**: every step is a hash-chained entry. In a terminal: `pnpm rocky audit verify`.
- Headless version: `pnpm rocky actions list --status draft`, `pnpm rocky actions approve <id>`.

## 5. Your memory in Claude Code (40 s)

```sh
claude mcp add rocky -- node E:/CODEBASE/Rocky/apps/cli/src/index.ts --data-dir E:/RockyDemo mcp
```

- In Claude Code: "Search my Rocky memory for the vendor renewal and tell me what I owe." It calls `search_memory` and cites the email.
- Say: the tools are read-only, results are marked as untrusted data, and local-only documents never reach the client.

## 6. Close (20 s)

- Open source under Apache-2.0, runs on your machine, no account.
- Point to the README quickstart and the connector plugin guide in CONTRIBUTING.md.

## Reset

Settings → **Delete everything**, or delete `E:\RockyDemo`.
