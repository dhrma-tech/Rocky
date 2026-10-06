# Setup checklist (things only you can do)

Times are rough. Items are ordered by when the phase needs them.

## Before Phase 0 / 1 — this machine

- [ ] **Disk:** C: has ~5 GB free. Keep all models and data on E:.
  - Set the user env var `OLLAMA_MODELS=E:\ollama\models` (System Properties → Environment Variables), then quit and restart Ollama.
  - The Rocky data dir will be `E:\RockyData` (set in config during Phase 0).
- [ ] **Ollama** (installed, 0.35). After the env var: `ollama pull nomic-embed-text`. The small instruct model tag is chosen in the Phase 0 spike. Don't pull large models yet.
- [ ] **ffmpeg** (only for importing existing audio/video): `winget install Gyan.FFmpeg`.
- [ ] **whisper.cpp:** nothing to do. `rocky doctor --fix` downloads the official Windows `whisper-cli` release and the `ggml-small` model (~470 MB) to the data dir. Tell me if you prefer manual download.
- [ ] **Anthropic API key:** create it at console.anthropic.com and **set a monthly spend limit in the console** (second fence besides Rocky's budget cap). You'll paste it into Rocky Settings; it's stored in Windows Credential Manager.
- [ ] Optional **Gemini API key** (aistudio.google.com). Note the free-tier data-use terms.
- [ ] Browser: Chrome or Edge (needed for system-audio capture).
- [ ] **Private eval material:** 3–5 lecture PDFs or slides, 1–2 lecture recordings, a few Notion pages, one GitHub repo. Put copies in `E:\RockyData\eval-src` (never in the repo).

## Before Phase 4 — Google, GitHub, Notion

**Google (≈30 min)**
- [ ] Create a GCP project (console.cloud.google.com), for example `rocky-personal`.
- [ ] Enable the APIs: Gmail API, Google Calendar API, Google Drive API.
- [ ] OAuth consent screen (Google Auth Platform → Branding/Audience):
  - User type **External** for a consumer Gmail; **Internal** for a Workspace account (no 7-day issue).
  - Add yourself as a test user.
  - Add scopes: `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `calendar.events`, `drive.readonly`, `drive.file`.
  - **Publish the app ("In production")** without submitting for verification. That avoids 7-day refresh-token expiry. You'll see an "unverified app" warning on consent; continue via Advanced. This is allowed for personal use.
- [ ] Credentials → Create OAuth client ID → **Desktop app**. Download the JSON; Rocky imports it into the keychain and you then delete the file (`rocky connectors google-client <file>`, or Connectors → Gmail → Import client file).
- [ ] In Phase 4 Rocky asks only for the read scopes (`gmail.readonly`, `calendar.readonly`, `drive.readonly`); the write scopes are requested in Phase 6.

**GitHub (≈5 min)**
- [ ] Fine-grained PAT: Settings → Developer settings → Fine-grained tokens. Choose the repos. Permissions: Metadata R, Contents R, Issues RW, Pull requests R. Expiry ≤ 366 days.

**Notion (≈5 min)**
- [ ] notion.so/profile/integrations → New internal integration → copy the token.
- [ ] Share each page or database you want synced with the integration (••• → Connections).

## Before Phase 7 — remaining services

- [ ] **Linear:** Settings → Security & access → Personal API keys.
- [ ] **Todoist:** Settings → Integrations → Developer → API token.
- [ ] **Slack (≈15 min):**
  - Create the app from the manifest Rocky ships (`packages/connectors/src/slack/manifest.yaml`) at api.slack.com/apps.
  - Enable Socket Mode and generate an app-level token with `connections:write` (`xapp-…`).
  - Install to the workspace and copy the bot token (`xoxb-…`).
  - `/invite @Rocky` in each channel to sync. Managed workspaces may need admin approval.
- [ ] **Apple Calendar:**
  - appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate one (2FA required).
  - Username = your Apple ID email.
- [ ] **Asana:** My settings → Apps → Developer apps → Personal access token.
- [ ] **PostHog:** Personal API key with scopes `query:read` and `insight:read`. Note the project ID and region (us/eu).

## Before Phase 9

- [ ] Choose the license (Apache-2.0 recommended).
- [ ] Vercel: link the repo, root `apps/landing`.
- [ ] A spare Windows user account (or VM) for the fresh-clone test.
