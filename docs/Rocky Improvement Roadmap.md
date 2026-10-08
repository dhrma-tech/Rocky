# Rocky Improvement Roadmap

Oct 8, 2026 · @Dharmaraj Sunil Aparadh

This roadmap follows from Report 2 (Rocky vs the market). It covers what to add, modify, improve, remove and differentiate, with a zero-budget approach for each major item.

## Roadmap 1: Add

Eleven additions, ordered by priority. Each lists why it matters, which competitor exposes the gap, the user value, difficulty, priority, realism for a small student team, and a zero-budget implementation. Free-tier limits and model names change quickly, so check them before committing.

### A1. One-command installer and packaged release

- **Why:** The current install (clone, pnpm, Ollama) excludes most of the students and founders in your pitch. A third-party analysis of Grok Bot argues its real innovation is that nothing has to be configured \[R\].
- **Exposed by:** All three, which install in a few clicks.
- **User value:** Moves your funnel from developers to technical students.
- **Difficulty:** Medium to high, roughly 2 to 4 weeks. **Priority:** Critical. **Realistic:** Yes.
- **Zero-budget approach:** Wrap the daemon and web UI in a Tauri or Electron shell. Build macOS, Windows and Linux installers in GitHub Actions, which is free for public repositories. Have the first-run step detect RAM, check for Ollama and pull a model sized to the machine. Ship a Docker Compose file as fallback, plus Homebrew, winget or scoop manifests. Unsigned installers trigger OS warnings; look into free code-signing programs for open source and document the workaround meanwhile.

### A2. Live connector validation and honest status tiers

- **Why:** Connectors that only passed against recorded fixtures will break on first contact with real accounts, and that ends trust.
- **Exposed by:** Muse, which worked with each provider and wrote SKILL instructions per connector. Dots and Grok Bot ship vendor-maintained plugins.
- **User value:** First-run success and correct data.
- **Difficulty:** Medium. **Priority:** Critical. **Realistic:** Yes for five connectors, no for twelve.
- **Zero-budget approach:** Pick Gmail, Google Calendar, Drive, GitHub and Notion as 'supported'. Test with your own accounts and free developer tiers. Run nightly smoke tests in GitHub Actions against dedicated test accounts held as repository secrets. Label the rest 'experimental' in the UI and README. Handle token refresh failures and rate limits visibly.

### A3. Phone and messaging front end

- **Why:** All three live where users already are, in ChatGPT, WhatsApp, Slack and iOS. Rocky is a localhost page.
- **Exposed by:** All three.
- **User value:** Ask questions, receive briefs and approve drafts from a phone.
- **Difficulty:** Medium. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** A Telegram bot (free API) or Matrix bridge with a user-ID allowlist, and a PWA of the existing web UI reachable through Tailscale or a Cloudflare Tunnel free tier. Approvals arrive as buttons showing a payload summary and hash, with the full payload in the PWA. Treat every channel message as untrusted input.

### A4. Rule-based approvals with scoped, time-bound grants

- **Why:** A flat queue causes approval fatigue. Muse's design post calls out banner blindness and builds one-time, session, task, time-bound and perpetual grants. Dots has four rule behaviors. Grok Bot has Ask-first and Allow-automatically rules, where Ask-first wins conflicts.
- **Exposed by:** All three.
- **User value:** Fewer interruptions without losing control.
- **Difficulty:** Medium. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** A policy table in SQLite or YAML keyed by connector, action class and payload constraints such as recipient domain, label or amount, resolving to allow, ask or block. Keep your invariants: email stays draft-only, deletes and sends default to ask, and every auto-allowed action still writes its payload hash to the audit chain. Add 'ask first wins' conflict resolution and grants that expire.

### A5. Inspectable, editable, versioned memory profile

- **Why:** Rocky indexes your sources but, per the brief, has no described profile of preferences, people and projects. Muse lets users read and edit memory files. Dots does not.
- **Exposed by:** Muse (as the benchmark) and Dots (as the weakness to exploit).
- **User value:** Personalization you can see and correct, which also supports your trust story.
- **Difficulty:** Medium. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** Store the profile as markdown files in a git repository inside Rocky's data directory. A local model proposes edits, each line carrying provenance: stated by the user, or extracted from a named source. Memory edits arrive as proposals through the existing approval queue and are accepted as diffs. Add `rocky memory export`. Never store model inferences as facts.

### A6. User-defined routines and skills

- **Why:** Rocky has fixed briefs and reports. Users want 'every Monday, summarize this and draft that'.
- **Exposed by:** Grok Bot routines and skills, Muse schedules, Dots scheduled tasks.
- **User value:** Turns Rocky from a tool you open into one that works for you.
- **Difficulty:** Low to medium. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** A routine is a markdown or YAML file with schedule, prompt, allowed tools and approval boundary. A scheduler inside the daemon runs it, catches up after sleep, and saves the output as a cited note. Use a folder-per-skill layout like the one other agent ecosystems use, so skills can be shared; confirm format compatibility before promising it.

### A7. Proactive heads-up engine

- **Why:** Rocky already extracts commitments and decisions. Surfacing 'you owe X by Friday' at the right time is the cheapest large UX win. Muse sets a high bar for unprompted messages and judges whether a result is worth surfacing.
- **Exposed by:** Muse and Dots.
- **User value:** The assistant feels alive without autonomy risk.
- **Difficulty:** Low to medium. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** A nightly job scores commitments by due-date proximity and staleness, applies a threshold and a daily cap, and notifies through the desktop or Telegram. A dismiss button lowers similar future scores. Give the job read-only tools by construction, as Dots does for proactive research.

### A8. Hardware-aware model setup and a speed profile

- **Why:** One to two minutes per answer is the biggest UX gap against hosted agents.
- **Exposed by:** All three, which hide inference latency.
- **User value:** Answers fast enough to use daily.
- **Difficulty:** Medium. **Priority:** High. **Realistic:** Partly. You can narrow the gap, not close it.
- **Zero-budget approach:** Detect RAM and GPU, and recommend model tiers. Third-party reports name Qwen, Gemma 4 and GLM families as the most reliable open tool-callers at various sizes, but validate against your own eval \[R\]. Use a small model for retrieval and verification and a larger one only for synthesis. Stream the answer sentence by sentence as each passes verification. Cache embeddings and retrieval. Offer an optional free-tier cloud model behind the local-only gate, after checking current limits and terms.

### A9. First-run sample workspace

- **Why:** Muse's design post says users could do so much they did not know where to start, so it added an Ideas tab. An empty Rocky is worse.
- **Exposed by:** Muse.
- **User value:** First cited answer in minutes, before importing anything.
- **Difficulty:** Low. **Priority:** High. **Realistic:** Yes.
- **Zero-budget approach:** Ship a fictional dataset of meetings, mail and documents with a guided tour that works fully offline. After the user's first import, generate suggested questions from their own data.

### A10. Activity view

- **Why:** Dots has Activity View, Muse an activity log, Grok Bot an Agent Computer view and routine history. Rocky has an audit log but, per the brief, no live view of work in flight.
- **Exposed by:** All three.
- **User value:** The user always sees what is running, scheduled, waiting for approval or failed.
- **Difficulty:** Low. **Priority:** Medium. **Realistic:** Yes.
- **Zero-budget approach:** One UI page over the existing audit log and job table, with pause and stop buttons and per-connector sync status.

### A11. Read-only web capture as a citable source

- **Why:** All three can browse. Rocky cannot bring a web page into an answer. Saving a snapshot and citing it keeps your verification promise.
- **Exposed by:** All three.
- **User value:** Answers can combine your files with a cited external page.
- **Difficulty:** Medium. **Priority:** Medium. **Realistic:** Yes.
- **Zero-budget approach:** Playwright in a sandboxed subprocess fetches the page, extracts readable text, and stores the snapshot with its hash. No logins and no form submission. Mark the content untrusted and apply the injection rules in Improve.

## Roadmap 2: Modify, Improve, Remove or Avoid

### Modify: redesign what exists

- **M1. Reposition and relabel.** Move from 'assistant' to 'verifiable memory and approval layer'. Rename 'Download' to 'Install from GitHub' until an installer exists, and aim the page at technical early adopters and students who can use a terminal. *Why:* your brief lists the CTA mismatch and three-audience dilution as top weaknesses. *Exposed by:* all three own the 'assistant' frame with frontier models and one-click installs. *Value:* an honest fit between promise and install. *Difficulty:* low. *Priority:* Critical. *Realistic:* yes. *Zero-budget:* copy changes plus a 'Rocky vs cloud agents' page comparing only documented facts: custody, citation verification, approval binding, cost.
- **M2. Approval cards for humans.** Replace raw JSON with a readable before-and-after summary, a risk label, the destination, and an expandable hash and payload. *Why:* Muse and Grok Bot both show structured cards with target and inputs. *Value:* approvals non-developers can judge. *Difficulty:* low to medium. *Priority:* High. *Realistic:* yes. *Zero-budget:* per-connector templates that render the payload; fall back to JSON.
- **M3. Honest connector count and tiers.** The brief counts 12 apps including a link-only connector with no access of its own, so 'Twelve apps, one memory' overstates. Say 'supported', 'experimental' and 'link-only'. *Why:* trust, and Muse's per-connector depth sets the bar. *Difficulty:* low. *Priority:* Medium. *Realistic:* yes. *Zero-budget:* a status field in connector metadata surfaced in UI and README.
- **M4. Local-first routing with an outbound preview.** Today the site recommends the API key path. Default to local, escalate to a cloud model only when retrieval confidence or verification pass rate is low, and show the exact passages about to leave before each call, with a per-query toggle. *Why:* Dots scales sharing rules by data sensitivity and Muse runs classifiers on outbound personal data; Rocky's privacy claim needs a visible equivalent. *Value:* privacy you can see. *Difficulty:* medium. *Priority:* High. *Realistic:* yes. *Zero-budget:* confidence from retrieval scores and the verifier's pass rate, regex and small-model tags for sensitive classes, and the existing single gate for local-only mode.
- **M5. Encryption on by default.** Make SQLCipher the default for new installs with the key in the OS keychain, with a migration path for existing stores. *Why:* all three encrypt at rest by default. *Difficulty:* low to medium. *Priority:* Medium. *Realistic:* yes.
- **M6. Package the notebook as a 'Study' mode.** Separate onboarding and a distinct landing section so engineers and founders are not diluted. Keep it: none of the three offers it. *Why:* it is a genuine wedge, but only reachable once install is easy. *Difficulty:* low. *Priority:* Medium. *Realistic:* yes.

### Improve: strengthen what exists

- **I1. Prompt-injection and credential isolation.** Extend untrusted-content labelling from MCP results to everything ingested from outside: mail, chat exports, web captures, PDFs. When untrusted text is in context, any write proposal shows where the instruction came from and gets stricter review. Strip one-time codes and password-reset links at email ingestion, as Muse's connector does. Run connector code in a separate process holding the keychain access, so the model process never touches tokens. Put an allowlist egress proxy around connector processes. Add a public injection test suite to CI with hidden instructions in PDFs, emails and web pages. *Why:* every vendor states injection is reduced, not solved, and Rocky ingests the highest-risk sources. *Exposed by:* Muse (privsep, authd, tainted egress) and Dots (checks outside the agent's reach). *Value:* the safety story you advertise. *Difficulty:* medium to high. *Priority:* Critical before adding any new write path. *Realistic:* yes, incrementally. *Zero-budget:* OS keychain, a small local forward proxy, separate Node worker processes, pytest-style adversarial fixtures.
- **I2. Eval that others can reproduce.** Publish citation faithfulness, 'Not found' precision and recall, dropped-sentence rate and latency by hardware tier, with adversarial and multilingual sets. *Why:* none of the three publishes comparable numbers, and a press analysis says Hermes Agent over-reports its own success \[R\]. *Value:* turns your verification claim into evidence. *Difficulty:* low to medium. *Priority:* High. *Realistic:* yes. *Zero-budget:* the existing public eval set extended, run in CI on a small model.
- **I3. Daemon as an OS service.** Install launchd, systemd user and Windows service units through `rocky doctor --fix`, with auto-start, catch-up after sleep, and daily SQLite backups. *Exposed by:* all three run unattended. *Value:* it actually works while you are busy. *Difficulty:* medium. *Priority:* High. *Realistic:* yes. *Zero-budget:* generated service files and `VACUUM INTO` backups; document an old laptop, Raspberry Pi or free-tier VPS for always-on use.
- **I4. Citation experience.** Show how many sentences were dropped and why, and open the exact page or timestamp with the quote highlighted. *Why:* the verification is invisible unless users see it working. *Difficulty:* low. *Priority:* Medium. *Realistic:* yes.
- **I5. Commitment extraction precision.** Measure precision on labelled meetings, add a one-click correction that feeds the eval set, and cite the line behind each commitment. *Why:* wrong 'you owe' items destroy trust faster than missing ones. *Difficulty:* medium. *Priority:* Medium. *Realistic:* yes.
- **I6. Multilingual quality.** Test Hindi, Marathi and code-mixed lectures and chats with multilingual whisper models and an open multilingual embedding model such as BGE-M3, then publish results. *Why:* an unclaimed niche if quality holds \[S\]. *Difficulty:* medium. *Priority:* Medium. *Realistic:* yes, quality is the risk.
- **I7. Release and supply-chain hygiene.** Dependabot, CodeQL, pinned dependencies, signed release attestations and a written threat model, all free on public GitHub repositories. *Exposed by:* Muse's open bounty up to $300,000, and press reports of serious CVEs in the OpenClaw agent runtime \[R\]. *Difficulty:* low. *Priority:* Medium. *Realistic:* yes.

### Remove or avoid: what to stop doing

- **X1. Freeze new connectors.** Do not add or maintain Apple Calendar, Asana or PostHog beyond best effort until the core five pass live nightly tests. *Why:* a long list of untested connectors is a liability. *Priority:* Medium. *Difficulty:* none.
- **X2. Retire 'Recommended: your API key' framing.** It contradicts the local-first identity. Present local as default and the key as an opt-in accelerator, with the outbound preview from M4. *Priority:* Medium.
- **X3. Avoid autonomy marketing.** Do not imply Rocky acts like Grok Bot, Muse or Dots. Say what it does: remembers, cites, drafts, waits for approval. *Priority:* High.
- **X4. Avoid blanket 'always allow'.** Allow grants only with payload constraints and an expiry. *Priority:* High.
- **X5. Drop low-value spec items.** The floating hero cards, the curved connector gallery and the Product dropdown add polish, not proof. Spend that time on real screenshots and a short demo. *Priority:* Low.
- **X6. Avoid a hosted tier, telemetry and trajectory training.** Keep the no-backend decision. It is part of the edge.
- **X7. Do not build voice, avatars or multi-agent orchestration this half.** None addresses a Rocky bottleneck.

## Roadmap 3: Differentiate

Seven moves that turn Rocky's built assets into a position the big three cannot copy without abandoning their model. D1 is the single highest-leverage idea in this roadmap.

### D1. Rocky as the trust gateway for other agents

- **What:** Extend the read-only MCP server so any MCP-capable agent can search Rocky with verified, cited results, and can propose writes into Rocky's approval queue. Nothing runs until the user approves a payload bound to its hash, and the agent gets a receipt back.
- **Why it matters:** The three big products are closed. The open-source agent frameworks are popular but weak where Rocky is strong: a press analysis says Hermes Agent over-reports success, and OpenClaw has had serious vulnerabilities \[R\]. Rocky becomes the layer they plug into rather than a rival, and gets distribution through their communities.
- **Exposed by:** All three, by being closed; Muse and Dots, by building a similar gate privately for their own agents only.
- **User value:** Existing agents gain verified retrieval and safe writes. Users keep one memory and one approval inbox.
- **Difficulty:** Medium. **Priority:** High. **Realistic:** Yes, most components exist.
- **Zero-budget approach:** Add `propose_action` and `get_receipt` tools to the MCP server. Reuse the approval queue and audit chain. Authenticate agents with per-agent tokens and scope each to connectors and action classes. Publish setup recipes for Claude Code, OpenClaw and Hermes Agent, and list Rocky in public MCP directories.

### D2. Receipts for agent actions

- **What:** Add `rocky audit verify`, export, and optional anchoring of the chain head to a public git commit. Produce an evidence pack per action: sources, payload, approver, time and result.
- **Why it matters:** None of the three documents tamper evidence \[?\]. Compliance-minded users and small teams can use this directly.
- **Difficulty:** Low to medium. **Priority:** Medium to high. **Realistic:** Yes.
- **Zero-budget approach:** The chain exists. Add a verifier command, a JSON or PDF export, and a scheduled job that commits the head hash to a repository.

### D3. Fail-closed answers as the brand

- **What:** Make 'Not found in your sources' and visible dropped sentences the headline, backed by published faithfulness numbers. Offer a 'verified mode' that other tools can call.
- **Why it matters:** Competitors ask you to trust summaries. Grok Bot's own guide tells users to ask the Bot to cite and reopen current data for consequential decisions, which is manual.
- **Difficulty:** Low, since it builds on I2 and I4. **Priority:** High. **Realistic:** Yes.

### D4. Memory you own and can move

- **What:** Combine A5 with importers for other assistants' exports, such as ChatGPT and Claude conversation archives, and a clean export. Rocky already imports WhatsApp, Discord, Instagram, X and LinkedIn exports.
- **Why it matters:** Dots memory cannot be edited item by item and is deleted only by resetting the dot. A portable memory lowers switching cost and signals no lock-in.
- **Difficulty:** Low to medium. **Priority:** Medium. **Realistic:** Yes.
- **Zero-budget approach:** Parse the archive formats into the existing import pipeline, with the same provenance tagging used by A5. Validate the export formats before promising support.

### D5. Sovereign, offline and multilingual

- **What:** Work well on 8 to 16 GB machines, offline, in Indian languages and code-mixed speech, with published numbers.
- **Why it matters:** Every competitor needs the cloud and an account. Dots excludes the EEA, Switzerland and the UK for Pro, and Muse is US-only.
- **Difficulty:** Medium. **Priority:** Medium. **Realistic:** Yes, with quality as the main risk. Builds on A8 and I6.

### D6. Cited commitments ledger

- **What:** A first-class view of who owes whom what by when, across meetings, mail and chat, each with the quoted evidence and nudges before due dates.
- **Why it matters:** Competitors offer goals and tasks, and I found no cross-source, cited obligation tracker \[?\]. Founders and students both feel this pain.
- **Difficulty:** Medium. **Priority:** Medium to high. **Realistic:** Yes, builds on existing extraction and A7.

### D7. Study as a wedge

- **What:** Lead with notebooks, cited study guides, quizzes, spaced repetition and Anki export once install is easy.
- **Why it matters:** None of the three has it \[?\], students are your most price-sensitive and least served segment, and word of mouth on campus is free.
- **Difficulty:** Low. **Priority:** Medium. **Realistic:** Yes, after A1.

## Sequencing, gates and risks

Build trust before reach. Ship an installable, reliable Rocky first, then the surfaces and controls that make it usable daily, then the moves competitors cannot copy.

&#91;embedded content: roadmap · 3 phases, 3 gates\]

Phase lengths and gate criteria are my proposed targets for a small team, not benchmarks. Adjust them to your real capacity. Codes refer to the roadmap items above.

### Risks and unknowns

- **Google restricted scopes.** Distributing an app that reads Gmail to many users may require Google's app verification and a paid third-party security assessment. I could not verify the current rules or costs, so check them before promising Gmail to the public. A bring-your-own OAuth client may avoid the problem for individual users \[S\].
- **Local verification quality.** Small models may verify citations less reliably than large ones. Measure this in I2 before leaning on the claim.
- **Bus factor.** One contributor limits everything. A docs site on free static hosting, a connector template and labelled starter issues are what let others help.
- **Recording consent.** Meeting and lecture recordings raise consent-law questions that vary by place. Keep the guidance in your FAQ prominent.
- **Moving competitors.** Muse's Confidential VM and Dots' enterprise controls could narrow the privacy gap. Revisit this roadmap in 90 days.
- **Thin evidence.** The three products are days to weeks old, and the competitor analysis rests mostly on vendor documents. Model names, free-tier limits and file-format compatibility here come from third-party summaries and should be validated before you build on them.
