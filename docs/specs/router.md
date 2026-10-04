# Spec: Model router

## Interface

```ts
type Task = 'transcribe' | 'embed' | 'tag' | 'title' | 'chunk_summary' | 'doc_summary'
  | 'meeting_summary' | 'extract' | 'classify' | 'chat' | 'verify' | 'quiz_gen' | 'quiz_grade'
  | 'flashcard_gen' | 'draft' | 'routine' | 'propose_actions' | 'mindmap';

interface RunRequest<T> {
  task: Task;
  input: ModelInput;              // messages; untrusted parts already wrapped
  schema?: ZodType<T>;            // structured output
  tools?: ToolSet;                // only allowed when origin permits (see SECURITY.md)
  origin: 'user_turn' | `routine:${string}` | 'system';
  scope?: { notebookId?: string; localOnly?: boolean };
  hints?: { inputTokens?: number; examGrade?: boolean; maxTokens?: number };
}
interface RunResult<T> { output: T; path: PathInfo; usage: Usage }
interface PathInfo { provider: string; model: string; local: boolean; attempts: number; fallbackReason?: string }
```

Everything goes through `router.run()`. Providers are registered in a `ProviderRegistry`:
- `ollama`: chat via `@ai-sdk/openai-compatible` at `http://127.0.0.1:11434/v1`; embeddings via native `/api/embed`.
- `anthropic`: `@ai-sdk/anthropic`.
- `google`: `@ai-sdk/google`.
- `openai_compatible`: user-supplied base URL.

`whisper` is a non-LLM provider, used for `transcribe`.

## Policies (`config/policies.yaml`, user override in data dir, notebook override in `notebooks.scope.policy`)

```yaml
tasks:
  tag:            { primary: local:small,  fallback: api:cheap,  escalate_on: [json_invalid_x2, timeout_60s] }
  meeting_summary:{ primary: tier(local:medium if ram>=15 && gpu else api:strong), fallback: api:strong, escalate_on: [input_tokens>12000, json_invalid_x2] }
  chat:           { primary: api:strong,   fallback: local:medium }
  verify:         { primary: api:cheap,    fallback: local:small }
  quiz_gen:       { primary: local:medium, exam_grade: api:strong }
  draft:          { primary: api:strong }
  propose_actions:{ primary: api:strong,   local_allowed: false_below_14b }
models:                       # IDs are config, never hard-coded. Re-verify before release.
  api:strong: anthropic/claude-sonnet-5-5
  api:cheap:  anthropic/claude-haiku-4-5-20251001
  local:small:  ollama/<chosen in Phase 0 spike, ~3-4B instruct>
  local:medium: ollama/<~7-8B instruct>
  embed:        ollama/nomic-embed-text
  transcribe:   whisper/ggml-small
```

### Resolution order

1. Notebook policy, then user policy, then default.
2. Expand tier aliases.
3. Apply the hardware profile.
4. Apply local-only. Under local-only, API targets are replaced by the best local fallback. If there's none (for example `propose_actions`), fail with "this task needs an API model; local-only is on".

## Hardware detection (startup, cached, `rocky doctor` re-runs)

- RAM: `os.totalmem()`. GB tiers: <12 → `low`, 12–15 → `mid`, ≥15 → `high` (tolerance for reported 15.7 GB on "16 GB" machines).
- GPU:
  - Windows: `Get-CimInstance Win32_VideoController` + `nvidia-smi` presence.
  - macOS: `system_profiler SPDisplaysDataType` (Apple Silicon = unified memory, counts as GPU).
  - Linux: `nvidia-smi` / `rocm-smi`.
- Ollama: `/api/version`, `/api/tags` (models present), `/api/ps`.
- Benchmark (on demand): local:small tokens/s, whisper speed factor. Stored in settings and used to choose whisper `small` vs `base`.

Defaults for `low` RAM: all LLM tasks use API; embeddings and transcription stay local (as specified).

## ProviderGate (egress)

The only module allowed to import provider SDKs (lint rule). `call(target, req)`:
1. If `target.local == false` and (global local-only OR `scope.localOnly` OR the notebook's `local_only`), throw `EgressBlocked`.
2. Budget check: `estimate = price(model).in * (hints.inputTokens ?? countTokens(input)) + price.out * maxTokens`. If `monthSpend + estimate > cap`, throw `BudgetExceeded{cap, spent, estimate}`.
3. Call, with a timeout per task.
4. Write `usage_log` (actual tokens and cost) and `audit_log` event `model_call` (task, provider, model, local, tokens, no content).

The price table lives in `config/prices.yaml` and is user-editable, since prices change. Unknown model price → treat as blocked when a cap is set, with a message.

## Fallback and transparency

- Every `RunResult.path` is returned to the caller. The UI shows a chip such as "local · qwen… (fallback: JSON invalid twice)".
- Fallback triggers: `json_invalid_x2` (zod fail after 1 repair retry), `timeout_<n>`, `provider_down`, `input_tokens>N`.
- Retry once with validation errors appended. Then escalate per policy.

## Tests

- Policy resolution matrix, covering each task × local-only × RAM tier × notebook override.
- `EgressBlocked` under the socket stub, for every task.
- Budget: blocked at the cap; the message includes the numbers.
- Fallback: a fake local provider returns invalid JSON twice → API is called, and `fallbackReason` is set.
