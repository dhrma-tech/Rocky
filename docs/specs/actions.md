# Spec: Actions (approval queue, executors, audit)

## State machine

```
            edit (payload changes, hash recomputed)
           ┌──────┐
           ▼      │
 propose → draft ─┴─ approve(hash) → approved → execute → executing → executed
             │                         │                     └──────→ failed
             └─ reject → rejected      └─ revoke → draft
 failed → clone → new draft (never auto-retry)
```

- `approve(id, hash)`: the UI sends the hash of the payload it displayed. The server checks it matches the current `payload_hash` (the user approved exactly what they saw), then sets `approved_hash`.
- `execute(id)`: requires `status=approved` and `sha256(canonicalJSON(payload)) == approved_hash`. Sets `executing` in a transaction, so double-execution is impossible. Calls the executor with the `idempotency_key`, then sets `executed` + `result`, or `failed` + `error`.
- Execution runs immediately after approval by default. Setting: "approve now, execute in batch".
- Bulk approve is allowed, but the UI requires viewing each high-risk item.

## ActionDefinition (declared by connectors)

```ts
interface ActionDefinition<P> {
  type: string;                  // 'github.issueCreate'
  title: string;
  schema: ZodType<P>;            // validated at propose AND at execute
  risk: 'low' | 'medium' | 'high';   // e.g. draft create = low, calendar event with attendees = high (sends invites)
  describe(p: P): { target: string; summary: string; diff?: unknown };   // what the UI shows
  execute(p: P, ctx: ExecContext): Promise<ExecResult>;                  // ctx has idempotencyKey, http, secrets
}
```

### V1 executors

| Type | Risk |
|---|---|
| `gmail.draftCreate` / `gmail.draftUpdate` | low |
| `gcal.eventCreate` / `gcal.eventPatch` | high when attendees are present |
| `gdrive.sourcePackWrite` | low |
| `notion.pageCreate` / `notion.pageUpdate` / `notion.rowCreate` / `notion.rowUpdate` | medium |
| `github.issueCreate` / `github.comment` | medium |
| `linear.issueCreate` / `linear.issueUpdate` | medium |
| `todoist.taskCreate` / `todoist.taskClose` | low |
| `asana.taskCreate` / `asana.taskUpdate` | low |
| `caldav.eventCreate` | medium |
| `slack.draftReply` | low (local only, no remote call) |

### Idempotency

- Executors pass the key where the API supports it.
- Otherwise they search before create: for example, a GitHub issue with the hidden marker `<!-- rocky:<key> -->` in the body, or a Notion page with a property.

## Audit log

- Event types: `action_proposed`, `action_edited`, `action_approved`, `action_rejected`, `action_executed`, `action_failed`, `model_call`, `recording_consent`, `connector_connected`, `connector_disconnected`, `deleted`, `settings_changed`, `local_only_changed`, `budget_blocked`, `egress_blocked`.
- `row_hash = sha256(prev_hash ‖ seq ‖ at ‖ event_type ‖ actor ‖ subject ‖ payload_hash ‖ canonical(meta))`. Genesis `prev_hash` = 64 zeros.
- `rocky audit verify` recomputes the chain and reports the first broken seq.
- Payload bodies are stored in `audit_payloads` (purgeable on deletion). The chain stays valid because it covers only the hash.

## Injection guards in this layer

- Proposals originate only from `origin ∈ {user_turn, routine:*}`. `system`-origin steps (ingest, extraction) can't create proposals; that's enforced in `ActionService.propose`.
- Allowed action types for a request are computed from the user's instruction (`classify` task on the **user text only**, never on retrieved text) and intersected with the proposals.
- Each proposal must carry ≥ 1 citation to the source that motivated it. Proposals whose citations point at `suspicious` chunks are shown with a warning and are never bulk-approvable.

## Tests

- Every transition, including illegal ones.
- Payload edit after approval → execute refused.
- Hash mismatch on approve → refused.
- Concurrent execute → one success.
- Executor import guard: a lint rule plus a runtime check that `execute` is called only by `ActionService`.
- An adversarial email produces zero proposals in an extraction run.
- No-send CI check.
