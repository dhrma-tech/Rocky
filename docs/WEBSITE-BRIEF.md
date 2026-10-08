# Rocky website brief: what it is, how it is built, and where it is weak

This brief is for discussing improvements to Rocky's marketing website (the landing page). It explains the product the site sells, who it is for, the rules the site must follow, every section as built, the visual system, the technical setup, and a candid list of weaknesses and open questions. Everything below describes the page as it exists today (`apps/landing` in github.com/dhrma-tech/Rocky, October 2026), not an ideal version.

---

## 1. The product the site sells

**Rocky** is an open-source (Apache-2.0), local-first AI assistant. It runs as a small background program (a "daemon") on the user's own computer, with a local web interface and a command line.

What it does:
- **Remembers work.** It imports and indexes local files (PDF, Word, Markdown, HTML, text), meeting and lecture recordings (transcribed locally with whisper), chat exports (WhatsApp, Discord, Instagram, X, LinkedIn), and 12 connected apps: Gmail, Google Calendar, Google Drive, Notion, GitHub, Linear, Todoist, Slack, Apple Calendar, Asana, PostHog, and a link-only Notion Calendar connector.
- **Answers with sources.** Every sentence of an answer cites the exact page, timestamp or message it came from. Each citation is checked twice: a deterministic check that the quoted text really exists in the source, then a second model pass that judges whether the quote supports the claim. Sentences that fail are removed. If nothing survives, the answer is literally "Not found in your sources."
- **Acts only with approval.** It can propose writes (a Gmail draft, a calendar event, a Linear issue, a Notion page), but each one waits in an approval queue showing the exact payload. Approval is bound to a hash of that payload, every step goes into a hash-chained audit log, and email is never sent, only drafted.
- **Extracts structure.** From meetings and messages it pulls out commitments ("you owe X by Friday"), decisions and people, and builds morning briefs, end-of-day summaries and weekly reports.
- **Student notebooks.** Course notebooks group lectures, slides and readings. They provide cited study guides, quizzes with graded feedback, flashcards on a spaced-repetition schedule, an exam countdown with weak topics first, and export to Anki or Markdown.
- **Open to other tools.** A read-only MCP server lets Claude Code and other AI tools search the user's memory, with results marked as untrusted data.

How it runs:
- Embeddings, transcription and small tasks run locally through Ollama and whisper.
- Hard questions can use the user's own Anthropic key (Claude), with a monthly budget cap ($10 by default).
- A "local-only" mode blocks every outside model call at a single gate in the code.
- The store is one SQLite file on the user's machine. Encryption (SQLCipher) is opt-in, with the key in the OS keychain.

**Honest state of the product:**
- It is early software. All 10 planned build phases are finished, CI is green, and the public evaluation set meets the release gates on the local model.
- There is **no installer or packaged release**. Installing means `git clone`, `pnpm i` and `pnpm rocky doctor --fix`. That requires Node.js, pnpm and Ollama, so it is a developer-grade install.
- Most connectors have only been tested against recorded fixtures, not live accounts.
- The repository has 0 GitHub stars and 1 contributor.
- Local answers on a CPU-only laptop take a minute or two.

---

## 2. Who the site is for

The product was designed around three segments. The site addresses all three:

1. **Students and academics.** Lectures, slides, readings, deadlines and exams. The notebook module is built for them.
2. **Founders and operators.** Meetings, email follow-ups, promises made, decisions and weekly reports.
3. **Product and engineering people.** Specs, Slack threads, GitHub and Linear issues, with meetings turning into tickets.

The realistic first audience, given the install story, is **technically capable early adopters**: developers, technical students and open-source enthusiasts who care about privacy and are comfortable with a terminal. That tension between a broad audience in the copy and a narrow audience in practice is one of the main things to discuss (see §9).

The site's job, in order:
1. Make the idea clear in one screen: remembers your work, answers with sources, acts only with approval, runs on your machine.
2. Make the trust model believable: citations, approvals, local-first, open source.
3. Send people to GitHub, to install it, star it or contribute.

---

## 3. Rules the site must follow

These come from the project's design spec (`docs/DESIGN.md` §4) and its honesty rules. Suggestions should respect them or argue explicitly for changing them.

- **No claims the product cannot back.** No invented logos, testimonials, user counts, certifications or "encryption" claims beyond what ships. Demos are labeled **"Sample"** and use fictional data.
- **No account, no sign-in wall.** Every call to action is Download (currently the README quickstart), Star on GitHub, or Read the docs.
- **No backend call from the page, no runtime third-party requests, no analytics.** Repo facts (stars, contributors) are fetched once at **build time** and hidden if unavailable. Fonts are self-hosted.
- **Palette is fixed** (user-supplied, final). Five colors plus derived tones; nothing outside them (see §5).
- **Voice:** plain, second person, confident. No exclamation marks, no superlatives. Short declaratives ending in a period. Headlines of 4 to 8 words. Call-to-action labels are a verb plus an object: "Download", "Star on GitHub", "Read the docs →".
- **Accessibility:** WCAG AA contrast for all text, 44 px minimum touch targets, one focus style everywhere, skip link, correct heading order, reduced-motion support.
- **Performance budget:** under 2 MB on first load and under 6 MB total.
- **Structure reference:** the layout rhythm was modeled on a measured teardown of a commercial landing page (tryclico.com). It uses a floating pill header, a hero that *is* the product, a pinned input-to-output demo, one dark section, bento cards, an FAQ, a final call to action and a large footer panel. Palette, fonts and copy are Rocky's own.

---

## 4. The page, section by section (as built)

Desktop height is about 11,000 px at 1280 px wide, roughly 12 screens at 900 px tall. The page is light-themed, with one dark section.

### 0. Announcement bar
- One centered line: a blush pill "Early version", then "Rocky is in active development. Follow along on GitHub.", then a link "See what changed →" to the commit history.
- It can be dismissed with ×, and the dismissal is remembered in localStorage.
- There is no version number, because there is no release.

### 1. Header (floating pill)
- A sticky, centered glass pill (blur, translucent canvas color, float shadow) about 56 px high, sitting just below the bar.
- Contents:
  - Logo mark (a cocoa "pebble" SVG) and the wordmark "Rocky" in the display serif.
  - Mono uppercase nav links: Product, Connectors, Students, Privacy, Docs. Product, Connectors, Students and Privacy are in-page anchors; Docs goes to the GitHub docs folder.
  - A ghost "GitHub" button with a star icon. The star count is hidden while it is 0.
  - A red **Download** button.
- At 1000 px and below, the last nav links drop out. At 768 px and below, the nav collapses to a hamburger that opens a right-side drawer. The drawer traps focus and closes on Esc.
- The spec's "Product ▾" dropdown was **not** built; Product is a plain anchor.

### 2. Hero
- **H1:** "Your work, **remembered and cited**." A blush highlighter sweep animates once across "remembered and cited" (1.2 s).
- **Demo composer** (about 600 × 224, rounded, raised): a "SAMPLE" tag and the placeholder "Ask anything across your meetings, mail and docs." Bottom bar: a "+" button, an "Everything" scope chip, a "● local model" chip, and a Download button.
- **Three sample-question chips** below it: "What did we decide about pricing?", "Who owes me a reply?" and "Quiz me on lecture 4". Clicking one types the question into the composer, then reveals a scripted answer with numbered citation chips and source lines. One example: "You agreed to keep the current price for existing customers and raise it 10% for new ones from 1 November [1]", sourced to "Pricing call · 3 Oct · 24:10". No network is involved.
- **Scope chips:** six square icon tiles (Meetings, Messages, Docs, Tasks, Notebooks, Code). The active one widens to show its label, and it changes to match the chosen sample question.
- **Descriptor** (about 35 words): "Rocky remembers your meetings, lectures, messages, documents and apps on your own machine. It answers with sources you can check, acts only after you approve, and runs on local models or your own API key."
- **Install snippet:** a sunken mono well containing `git clone https://github.com/dhrma-tech/Rocky && cd Rocky && pnpm i && pnpm rocky doctor --fix`, with a copy button that shows a "Copied" toast. The line is long, so at desktop width it scrolls horizontally inside the well, and `--fix` is cut off visually.
- **Buttons:** Download (primary) and Star on GitHub (secondary).
- The spec's two floating decorative cards (a citation stack and an approval card drifting in) were **not** built.

### 3. Trust strip
A centered row of mono uppercase links: "Open source · Apache-2.0", "Runs on your machine", "No account needed", stars (hidden at 0), and "1 contributor". Each links to its proof (license, SECURITY.md, README, contributors page).

### 4. Pinned demo: "Ask. Cite. Draft. Approve."
- A large rounded panel with a periwinkle-to-blush gradient. Subhead: "One question across everything you keep, an answer you can check, and nothing sent until you say so."
- **Left column:** a simulated app card with a source label ("Team sync · 14 Sep"), the user's question bubble ("Did we agree on the renewal, and what do I owe the vendor?") and four tabs: Ask, Cite, Draft, Approve.
- **Right column:** four cross-fading panels, each with a caption:
  1. **Ask:** "Rocky searches meetings, mail and docs at once, on your machine." The plain answer is about renewing for a year and owing a signed order form by Friday.
  2. **Cite:** "Every sentence links to the exact place it came from. Unsupported sentences are dropped." The same answer appears with citation chips [1] and [2], and a source list quoting the transcript line and the vendor email.
  3. **Draft:** "Replies are drafted in your voice and saved as drafts. Rocky never sends email." A draft reply to "Dana" follows.
  4. **Approve:** "Writes to your apps wait for you, with the exact payload shown." An approval card shows "Linear · create issue · medium risk", a JSON payload, Reject and Approve buttons, and "Nothing runs until you approve."
- Footnote: "SAMPLE · Fictional data. No request leaves this page."
- **Behavior:** at 900 px wide or more, 700 px tall or more, and with motion allowed, the panel is 320 vh tall with a sticky inner area. Scroll progress steps through the four tabs, and the tabs can also be clicked. On narrow or short screens, or with reduced motion, the pin is off and all four steps are stacked as cards.
- Not yet checked by scrolling in a real browser. Full-page screenshots show a long empty gradient below the content, which is the pin's scroll travel.

### 5. Connectors (dark section)
- Background `#1A110F` with 48 px rounded corners. H2: "Twelve apps, one memory."
- Lede: "Rocky keeps a local copy of what you connect and syncs it every few minutes. Every connector starts read-only. Tokens stay in your operating system's keychain. See setup and permissions."
- **A 4 × 3 grid of text-only tiles** (no logos), each with the app name in the display serif and a permission line, for example:
  - Gmail: "Reads; drafts after approval; never sends"
  - PostHog: "Read only"
  - Notion Calendar: "Links only, no access of its own"
- Below the grid: "Also: WhatsApp, Discord, Instagram, X and LinkedIn exports, imported once from a file."

### 6. Local-first explainer (same dark section)
- H2: "Local first, by default." Lede: "Your index lives on your machine. Embeddings, transcription and small tasks run locally. Hard questions use your own API key only when you add one."
- **An SVG diagram:** a dashed "YOUR MACHINE" boundary enclosing "Your apps" → "Local index (SQLite + vectors)". From the index, a solid arrow leads to "Local model" and a dimmer dashed arrow to "Your API key". The solid arrows draw once when the diagram scrolls into view.
- Two pill links with red arrow chips:
  - "Run local models": Ollama for embeddings and answers, fully offline in local-only mode.
  - "Bring your own API key": Claude for hard questions, with a monthly budget cap.

### 7. Audience bento ("Built for how you work.")
Three cards. Each mock is a list of small labeled rows, not a real UI screenshot:
- **Students and academics** (periwinkle gradient): "ECON 101 · Lecture 4 — Demand and supply", "Cards due — 12", "Exam — in 9 days".
- **Founders and operators** (blush-to-rose gradient): "You owe — Signed order form · Fri", "Owed to you — Q3 numbers from Sam", "Decided — Renew for one year".
- **Product and engineering** (full-width dark cocoa card): "Meeting — Sprint review · 3 action items", "Proposal — Create LIN-412 'Fix login timeout'", "Status — Waiting for your approval".

### 8. Student notebook ("A notebook for every course.")
- **Left:** a paragraph, four check-marked bullets (answers cited to the page or timestamp; quizzes and flashcards with spaced repetition; exam countdown with weak topics first; export to Anki or Markdown), the integrity line "Built to understand and retrieve, not to hand in as your own.", and "Read the notebook guide →". That link currently points to an internal spec file, not a user guide.
- **Right:** a notebook mock: "ECON 101 · 14 sources", a cited answer card ("Demand falls as price rises, all else equal [1] — Lecture 4 · 18:02"), and a flashcard card.

### 9. Privacy and control ("You decide what leaves.")
- **Three columns:**
  - "Stays on your device": files, transcripts, embeddings, the index; local transcription; tokens in the keychain.
  - "Can leave, if you choose": only the passages needed to answer, sent to the configured API model; local-only mode blocks it.
  - "Needs your approval": every write, with its exact payload, recorded in a hash-chained audit log.
- **Proof row:** a static audit-log row ("#2041 action_approved linear.issueCreate sha256 9f2c…a71e") and a "● Local only" badge.
- Links: "Read the security model →" and "Delete all your data in one click, from Settings."

### 10. Ways to run it
- Subhead: "Free and open source. You pay a provider only if you use your own API key."
- **Three cards:**
  - **Local models**: "Everything on your machine through Ollama. Free. Best with 16 GB of RAM." Button: Download.
  - **Your API key**: marked "Recommended", with a blush-to-rose gradient. "Local index and local tasks, with Claude for hard questions. A monthly budget cap is on by default." Button: Download (primary).
  - **Build on it**: connector plugins and MCP. Button: Read the docs.
- Below the cards: "Open issues" and "Contributing guide" buttons.
- There is no hosted tier, by decision.

### 11. FAQ ("Questions.")
Ten native `<details>` rows with a "+" that rotates on open. Each answer is under 80 words:
1. What Rocky stores and where.
2. Deleting data.
3. Supported models.
4. Offline use.
5. What connectors can access.
6. How approvals work.
7. Cost.
8. License.
9. Recording consent.
10. How it differs from a cloud assistant (ends with "It is early software: expect rough edges.").

### 12. Final call to action
H2: "Keep your work in one place you own." Subhead: "Open source, local first, and cited from the start." Download and Star on GitHub, plus the install snippet again.

### 13. Footer
- A large raised panel with a brand block: logo, the tagline "Your work, remembered and cited." and a one-line blurb.
- Four link columns: Product, Docs, Community, Legal.
- Bottom line: "© 2026 Rocky contributors · Apache-2.0 · This page loads no trackers."

---

## 5. Visual system

**Palette (final, user-supplied):**

| Name | Hex | Role on the site |
|---|---|---|
| Periwinkle | `#D0D9E6` | Sunken wells, gradients, student card |
| Blush | `#F2D3D3` | Badges, highlights, citation chips, question bubble |
| Rose | `#EDB0B1` | Gradients; accents and arrows on dark |
| Pastel red | `#E67E7F` | Primary buttons (always with dark ink text) |
| Cocoa | `#915E56` | Links, focus ring, logo |

Derived tones: ink `#2E1E1C` (text), ink-2 `#50342F` (secondary text), canvas `#EAEEF4` (page background), canvas-soft `#F1F4F8`, raised `#F8F9FB` (cards), blush-tint `#F8E9E9`, and dark page `#1A110F` with dark raised `#261816` / `#31201D`.

**Material:**
- One soft canvas. Surfaces rise with a white key light from the top-left and a grey-blue occlusion shadow to the bottom-right, a soft neumorphic look.
- Borders are almost absent: a 0.8 px white inner edge plus shadows.
- Radii are 12–14 px on controls, 20–28 px on cards, 32–48 px on section panels.

**Typography** (self-hosted, OFL licensed):

| Role | Font | Used for |
|---|---|---|
| Display | Instrument Serif 400 | Headings, wordmark, tile names |
| UI | Inter (variable) | Body and buttons |
| Mono | JetBrains Mono | Nav labels, tags, payloads, install command |

Sizes: H1 is fluid up to about 64 px with line-height 1.06. H2 is 32–42 px. Body text is 15–17 px.

**Motion:**
- 180–320 ms with ease-out or ease-ui curves: button lift on hover, chip expansion, step cross-fades, the one-time highlighter sweep and the one-time diagram arrow draw.
- Reduced motion turns off the pin, the transitions and the sweep.

**Logo:** a simple rounded "pebble" in cocoa with a blush highlight stroke and a small red dot, plus the serif wordmark. It is a placeholder-grade mark.

---

## 6. Technical setup

- **Stack:** a Vite static site with vanilla TypeScript and CSS, and no framework. The files are `index.html` (all content), `src/styles.css` (about 1,300 lines), `src/main.ts` (about 250 lines) and `public/logo.svg`.
- **Build output** (gzipped): about 7 KB of HTML, 6 KB of CSS and 2 KB of JS, plus font files (around 100 KB, Latin subsets only loaded via `unicode-range`). It sits far under the 2 MB budget. There are no images except SVG.
- **JavaScript does five things:**
  1. Dismissing the announcement bar.
  2. Injecting build-time repo facts.
  3. The mobile drawer (focus trap, Esc).
  4. The copy button and toast.
  5. The scripted hero answers, the scroll-driven demo tabs, and the diagram's IntersectionObserver.
- **Hosting (prepared, not live):** `vercel.json` sets the Vite build and strict security headers. The CSP allows only `'self'` for scripts, styles, fonts and images, with `connect-src 'none'`. It also sets `frame-ancestors 'none'`, `no-referrer`, a restrictive Permissions-Policy, and immutable caching for assets.
- **Deploy status:** creating the Vercel project through the connector failed with a permission error, so the site is **not live**. The plan is a dashboard import with root `apps/landing`.
- **Quality checks done:**
  - Lint (Biome, including its accessibility rules: semantic elements, anchor content, ARIA usage).
  - A typecheck.
  - Full-page screenshots at 1280 × 900 and 390 × 844 through headless Edge.
- **Not done:** Lighthouse, an axe audit, testing on real devices, or real-browser scrolling through the pinned demo.

---

## 7. Copy inventory (key lines)

- **Title / OG:** "Rocky: your work, remembered and cited". OG description: "Open-source, local-first memory for your work. Cited answers. Nothing runs without your approval." There is no OG image.
- **H1:** "Your work, remembered and cited."
- **H2s:**
  - "Ask. Cite. Draft. Approve."
  - "Twelve apps, one memory."
  - "Local first, by default."
  - "Built for how you work."
  - "A notebook for every course."
  - "You decide what leaves."
  - "Ways to run it."
  - "Questions."
  - "Keep your work in one place you own."
- **Repeated proof phrases:** "on your own machine", "sources you can check", "acts only after you approve", "Nothing runs until you approve", "never sends", "No request leaves this page".

---

## 8. Known weaknesses (my own assessment)

1. **The calls to action don't match the audience.** "Download" leads to a developer quickstart (Git, Node, pnpm, Ollama, a terminal). Students and founders, two of the three audiences in the bento, are unlikely to get through it. The CTA wording promises something easier than what's behind it.
2. **No real product visuals.** Every "UI" on the page is a stylized text mock. There are no screenshots, no short video and no GIF of the real app (Ask with clickable citations, the approval queue, a notebook). The page asserts the product more than it shows it.
3. **The hero composer is mostly empty until clicked.** The 224 px card shows one placeholder line and a lot of blank space. The sample answer only appears after a click, and many visitors won't click. There's no auto-play of the first sample.
4. **The install snippet is too long for one line.** It is truncated visually at desktop width (`--fix` is hidden) and becomes a horizontal scroller on mobile.
5. **The pinned demo may feel long.** 320 vh of scroll for four steps is about 2.2 extra screens of travel, and it hasn't been tested by scrolling in a real browser. Its value depends on the motion feeling good.
6. **The trust strip is thin at launch.** With 0 stars hidden, "1 contributor" is the only social number, and it may read as a weakness rather than proof.
7. **The connector grid is text-only.** No logos, by a rule against implying endorsement. It's honest but visually monotonous: 12 near-identical dark tiles.
8. **Three audiences on one page.** The bento, the notebook section and the copy try to serve students, founders and engineers at once, which may dilute the message. The student notebook gets a whole section; founders and engineers get one card each.
9. **Repetition.** Download and Star appear in the hero and the final CTA with the same install snippet. "Local", "approve" and "cited" ideas repeat across hero, demo, dark section, privacy, ways-to-run and FAQ.
10. **Missing spec items:** the Product ▾ dropdown, the floating hero cards, an OG image, a real version and changelog in the announcement bar, and the optional curved connector gallery.
11. **Placeholder-grade logo.** The pebble mark was a quick decision, not a designed identity.
12. **Weak link targets.** "Read the notebook guide →" goes to an internal spec file, the Docs nav item goes to a raw GitHub folder, and "Download" goes to a README anchor. There is no docs site.
13. **Light only.** The app has a dark theme; the landing page deliberately doesn't (beyond the one dark section).
14. **Unverified performance and accessibility numbers.** No Lighthouse or axe score yet. The demo tabs use `role="tab"` and `tabpanel` without complete ARIA wiring (`aria-controls` and `aria-labelledby` are missing).

---

## 9. Questions I want to discuss

1. **Positioning:** should the page target the people who can install it today (technical, privacy-minded early adopters), and treat students and founders as "coming when there's an installer"? Or keep the broad three-audience story?
2. **Hero:** is "Your work, remembered and cited." the right H1? Should the hero lead with the trust angle ("answers you can check", "nothing runs without approval") or the memory angle?
3. **Show, don't tell:** what's the best way to add real product proof within the rules (no runtime requests, small media budget)? Options: short WebM clips with posters, annotated screenshots, or a self-contained interactive replay.
4. **The CTA ladder** before an installer exists: rename "Download" ("Get started", "Install from GitHub")? Add a "Watch the 2-minute demo" as the primary action? Offer a waitlist? (A waitlist would conflict with "no backend".)
5. **Pinned demo:** keep the scroll-pinned four-step story, shorten it, or replace it with click-through tabs?
6. **Section order and length:** what to cut or merge to get under 10 screens? For example, merge "Local first" into "Privacy", or fold "Ways to run it" into the FAQ.
7. **Connectors section:** how to make it visually stronger without logos or implied endorsement?
8. **Social proof** for a brand-new open-source project with no users: what is honest and still persuasive?
9. **Identity:** logo, wordmark and the name "Rocky": is anything worth revisiting before launch?
10. **Copy:** any lines that feel generic, repetitive, or over-promising for early software?

---

## 10. Facts to keep fixed in any proposal

- Palette, the honesty rules, no runtime requests and no analytics are firm unless deliberately changed.
- Real capabilities include: cited and verified answers, "Not found in your sources", approval bound to the payload hash, an append-only hash-chained audit log, drafts only (never send), local-only mode, the $10 default budget cap, 12 connectors plus 5 chat-export importers, an MCP server, opt-in SQLCipher, delete everything, notebooks with quizzes, flashcards and Anki export.
- Real limits: no installer, a developer setup, slow local answers on CPU, connectors mostly untested against live accounts, 1 contributor, not deployed yet.
