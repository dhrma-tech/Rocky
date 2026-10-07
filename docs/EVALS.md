# Evals

Rocky's answers are judged on three gates (PLAN §6). The eval CLI runs a question set against a fresh store built from that set's corpus.

| Gate | Phase 1 | V1 release |
|---|---|---|
| hit@5 (a gold source in the top 5 chunks) | ≥ 0.80 | ≥ 0.80 |
| Citation validity (shown sentences whose citation supports them) | ≥ 0.90 | ≥ 0.95 |
| Abstention on unanswerable questions | ≥ 3/4 | 4/4 |

Answer correctness is reported for information; it is not a gate.

## Latest results

**Public set, local path, 2026-10-07** (`rocky eval --set public --local-only --fresh`, qwen3.5:4b via Ollama on a CPU-only laptop, ~70 min):

| hit@5 | Citation validity | Abstention | Correctness | Cost |
|---|---|---|---|---|
| 100% (26/26) | **100%** (37/37 sentences) | **4/4** | 92.3% | $0 |

This meets the V1 gates on the local path. Two caveats:
- 37 shown sentences is a small sample: one bad sentence would move validity by about 3 points. The previous local run (2026-10-04) measured 94.6%.
- The API path (Claude for answers, Haiku as verifier) has not been run yet; it needs an Anthropic key in the keychain.

Reports are written to `<dataDir>/evals/public-<timestamp>.json` with every question, retrieved chunk, sentence and verifier label.

## Running the evals

```sh
pnpm rocky eval --set public --fresh                 # API path (needs `rocky secrets set anthropic`)
pnpm rocky eval --set public --local-only --fresh    # everything on this machine
pnpm rocky eval --set public --limit 5               # quick smoke run
```

The public set lives in `evals/public` (corpus, `questions.yaml`, attribution). It covers PDFs, a meeting transcript, notes, email and GitHub-style issues, plus four unanswerable questions.

## The private set (your data)

The V1 plan also calls for a private run on real material. It stays out of the repo (`evals/private/` is git-ignored).

1. Put 3–5 lecture PDFs or slide decks, 1–2 lecture recordings, a few Notion pages and one GitHub repo export in `evals/private/corpus/`.
2. Write `evals/private/questions.yaml` in the same format as `evals/public/questions.yaml`: about 30 questions, each with an expected `answer` and `gold` entries naming the corpus file and a quote copied verbatim from it, plus at least 4 questions the corpus cannot answer (`answerable: false`).
3. Run `pnpm rocky eval --set private --fresh`, then `--local-only` as well.
4. If citation validity misses 95%, fix chunking and anchors first, then the quote check, then the verifier prompt (PLAN §6), and re-run.
