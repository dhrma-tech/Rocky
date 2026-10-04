# Rocky

A local-first, open-source, always-on AI assistant that remembers your work (meetings, lectures, messages, documents and apps) and answers with verified citations. It acts only after you approve.

> Status: planning. See [docs/PLAN.md](docs/PLAN.md).

- **Local-first:** your data stays on your machine. Local models where possible, your own API keys where they help. Local-only mode blocks every outbound model call.
- **One memory, many views:** course and project notebooks are scopes over one store, so cross-notebook questions work.
- **Trustworthy answers:** every claim is cited and checked against its source. "Not found in your sources" is a valid answer.
- **Safe actions:** every write to your apps goes through an approval queue and an append-only audit log. Email is never sent automatically.
- **Open:** memory is exposed over MCP for other AI tools.

> **Upcoming: STEVE integration.** Connect the assistant's memory to STEVE's AI departments so founders and admins get a cited company memory that agents can act on. Planned for V2.

License: [Apache-2.0](LICENSE).
