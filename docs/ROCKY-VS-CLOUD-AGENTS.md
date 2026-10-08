# Rocky and cloud agents

Rocky is a verifiable memory and approval layer, not an autonomous agent. It remembers, cites, drafts, and waits for your approval. This page lists only what Rocky does, each with where it is enforced or tested, and the same questions to ask any hosted agent you compare it with. It makes no claims about other products: check their own documentation.

| Question | Rocky | Where to check |
|---|---|---|
| **Custody.** Where does my data live? | In one SQLite file on your machine. No Rocky server exists; there is no account and no telemetry. Optional SQLCipher encryption with the key in your OS keychain. | [SECURITY.md](SECURITY.md) "Data at rest" |
| **Model calls.** What leaves my machine? | With local models (Ollama), nothing. An API key is optional; every network model call goes through one gate that enforces local-only mode and a monthly budget cap, and local-only documents never leave. | `core/src/router/gate.ts`, `local-only.test.ts` |
| **Citation verification.** Can I check an answer? | Every sentence must carry a quote that is found verbatim in the cited source, and a verifier pass checks support. Sentences that fail are dropped; with nothing left, the answer is "Not found in your sources". | `core/src/assistant/verified.ts`, [EVALS.md](EVALS.md) |
| **Approval binding.** Can an approved action change after I approve it? | No. Approval is bound to the SHA-256 of the exact payload you saw; an edit needs a new approval, and execution re-checks the hash. Proposals drafted from mail, chat, web pages or PDFs need an extra acknowledgement of their sources. Email is never sent, only drafted. | `no-write-without-approval.test.ts`, `untrusted-provenance.test.ts`, `no-send.test.ts` |
| **Audit.** Can I see what happened? | An append-only, hash-chained audit log; `rocky audit verify` recomputes the chain. | `audit-chain.test.ts` |
| **Credentials.** Who holds my tokens? | The OS keychain, read only by a separate connector host process; the process that runs models can't read them. Each connector may reach only the hosts it declares. | [SECURITY.md](SECURITY.md) "Secrets", `connector-host.test.ts` |
| **Cost.** What do I pay? | Rocky is free (Apache-2.0). Local models cost your hardware only; with an API key you pay the provider directly, under the budget cap ($10 a month by default). | `config/prices.yaml` |
| **Install.** How hard is it? | Today: clone, `pnpm i`, `rocky doctor --fix`. It assumes a terminal. A packaged installer is on the roadmap (A1). | [README](../README.md) |

What Rocky does not do: browse or log in on your behalf, send email, act without approval, or run unattended writes. Connectors are experimental until they pass live tests ([CONNECTORS.md](CONNECTORS.md)).
