# Connector setup

How to connect each of the 12 built-in connectors. All of them start **read-only**: Rocky syncs and remembers, and nothing is written anywhere until you switch a connector out of read-only on the Connectors page. Even then, every write is a proposal you approve first.

Tokens and passwords are stored in your operating system's keychain, never in files or the database.

**Validated live** means the connector was tested against a real account. The others were built from the current API documentation and tested against recorded-shape fixtures; their first real sync may surface differences.

| Connector | Validated live |
|---|---|
| GitHub, Notion, Gmail, Google Calendar, Google Drive | Pending your accounts |
| Linear, Asana, PostHog | Pending your accounts |
| Todoist, Slack, Apple Calendar, Notion Calendar | Fixture-only |

## GitHub

1. github.com → Settings → Developer settings → Fine-grained tokens → Generate new token.
2. Repository access: only the repositories Rocky should remember.
3. Permissions: Metadata (read), Contents (read), Issues (read and write), Pull requests (read).
4. In Rocky: Connectors → GitHub → add the repositories as `owner/name`, paste the token, then select **Test**.

Tokens expire (at most 366 days). Rocky warns two weeks ahead.

## Notion

1. notion.so/profile/integrations → New integration → Internal.
2. Capabilities: Read content. Add Insert content and Update content only if you want Rocky to propose pages and rows.
3. Copy the token and paste it into Rocky.
4. In Notion, open each page or database to remember → ••• → Connections → add the integration. Sub-pages are included.

## Gmail, Google Calendar and Google Drive

These three share one Google sign-in, made with your own Google Cloud project.

1. console.cloud.google.com → create a project.
2. Enable the Gmail API, the Google Calendar API and the Google Drive API.
3. Google Auth Platform → Audience → External. Then publish the app ("In production").
   - An app left in testing gets refresh tokens that expire after 7 days.
   - Unverified is fine for personal use: you'll see a warning the first time you sign in.
4. Clients → Create client → Desktop app → download the JSON file.
5. In Rocky: Connectors → Gmail (or Calendar or Drive) → import the client file → Sign in with Google.

Permissions Rocky asks for:
- **Gmail:** read, plus compose for drafts. Rocky never sends mail.
- **Calendar:** read, plus events for creating events. Invitations go out only if a proposal says so.
- **Drive:** read, plus files Rocky creates itself (the "Rocky source packs" folder only).

## Linear

1. Linear → Settings → Security & access → Personal API keys → New key.
2. In Rocky: paste the key. Optionally list team keys (for example `ENG`); leave the list empty to sync every team.

## Todoist

1. Todoist → Settings → Integrations → Developer → copy the API token.
2. In Rocky: paste it. Optionally list project names to keep; leave the list empty for all projects.

Completed tasks stay in Rocky as history.

## Slack

1. api.slack.com/apps → Create New App → From scratch, in your own workspace.
2. OAuth & Permissions → Bot Token Scopes: `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`.
3. Install to Workspace, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. In Slack, run `/invite @your-app` in each channel Rocky should remember.
5. In Rocky: paste the token. Optionally list channel names; leave the list empty for every channel the bot is in.

How it works:
- Rocky checks every 5 minutes and keeps the last 30 days by default.
- Each channel-day becomes one document.
- Drafted replies are never posted: Rocky gives you the text and a link, and you post it yourself.
- Managed workspaces may need an admin to approve the app.

## Apple Calendar (iCloud)

1. Your Apple ID needs two-factor authentication.
2. account.apple.com → Sign-In and Security → App-Specific Passwords → Generate. Name it "Rocky".
3. In Rocky:
   - Enter your Apple ID email and paste the app-specific password (not your normal password).
   - Optionally list calendar names.

How it works:
- Repeating events appear once, with their rule shown.
- Events Rocky creates have no guests, because iCloud would send invitations itself.
- Other CalDAV servers can work: set their URL as the server URL.

## Asana

1. app.asana.com/0/my-apps → Create new token.
2. In Rocky: paste it, then either:
   - add project ids (the number in a project's URL), or
   - add a workspace id to sync the tasks assigned to you.

Deleted Asana tasks are not reported by the API Rocky uses, so they stay in Rocky until you remove them.

## PostHog

1. PostHog → Settings → Personal API keys → Create key with scopes `insight:read` and `query:read`.
2. Project settings → copy the project id.
3. In Rocky:
   - Choose the host: `https://us.posthog.com`, `https://eu.posthog.com`, or your own URL.
   - Enter the project id and paste the key.

How it works:
- Once a day, Rocky stores a dated snapshot of each saved insight (up to 50, 20 by default).
- Rocky never writes to PostHog.

## Notion Calendar

Notion Calendar has no API. It shows your Google Calendar and Notion databases, and Rocky already reads both directly.

Turn this connector on and enter the Google account Notion Calendar uses. Google Calendar events on Home then get an **Open in Notion Calendar** link.

## Chat exports (WhatsApp, Discord, Instagram, X, LinkedIn)

These apps have no API Rocky can use, so you import an export file once (and again later to add newer messages). Import on the Connectors page (**Import an export**) or with `rocky import <file or folder>`. The format is detected; `--format` forces one.

| App | How to export | What to give Rocky |
|---|---|---|
| WhatsApp | Open the chat → More → Export chat (without media is enough) | The `.txt`, or the `.zip` |
| Discord | Settings → Data & Privacy → Request all of my data | The package `.zip`, or its unpacked folder |
| Instagram | Accounts Center → Your information and permissions → Download your information → **JSON** format | The `.zip`, or its unpacked folder |
| X | Settings → Your account → Download an archive of your data | The `.zip`, or its unpacked folder |
| LinkedIn | Settings → Data privacy → Get a copy of your data (Messages, Connections) | The `.zip`, or `messages.csv` / `Connections.csv` |

How it works:
- The file is read on this machine. Photos, voice notes and videos inside an export are skipped without being unpacked.
- Each conversation becomes one document per month (for example "WhatsApp · Sam · 2025-03"). Citations open the message where that part of the conversation starts.
- Importing the same export again changes nothing; a newer export adds or updates only the months that changed.
- Remove an import from the Connectors page. That deletes its documents, chunks and anything generated from them.
- Discord's data package contains only your own messages, so only those are imported.
- Tested with hand-made fixtures of each format; real exports change format over time. If yours is not recognized, the error names the files Rocky found.

## Claude Code and other MCP clients

Rocky exposes your memory to MCP clients with six read-only tools. They can search and read; they cannot write, send or approve anything.

```sh
claude mcp add rocky -- node E:/CODEBASE/Rocky/apps/cli/src/index.ts mcp
```

- Every result is wrapped as untrusted data, so the client's model treats it as evidence, not instructions.
- Local-only documents and notebooks are hidden. In local-only mode, every tool refuses. To allow both, set `mcp: { allowLocalOnly: true }` in `rocky.yaml`; the client may send what it reads to a cloud model.
- HTTP clients: with the daemon running, `rocky mcp --http` prints the endpoint. Requests need the install token (`--show-token` prints it). Prefer stdio, which needs no token.
