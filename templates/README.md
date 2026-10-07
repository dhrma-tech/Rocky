# Template packs

Each pack is a folder:

```
<pack>/pack.yaml              name, segment, description, recommended connectors
<pack>/routines/*.yaml        name, schedule (cron), inputs, prompt (path), output
<pack>/prompts/*.md           frontmatter (task, inputs) + prompt body with {{vars}}
```

Variables: `{{date}}` (e.g. Wednesday 7 October 2026) and `{{time}}` (24 h).

Inputs are named collectors (see `RoutineInputSchema`): `calendar_today`, `meetings_today`,
`week_meetings`, `commitments_due_7d`, `overdue`, `deadlines_14d`, `unread_important_threads`.

Overrides: a file at `<dataDir>/templates/<pack>/…` wins over the shipped one. Edits made in the
Routines screen are stored with the routine and win over both.

Routines only write cited summaries. They never send, and they never act without approval.
