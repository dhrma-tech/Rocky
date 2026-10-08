# Rocky UI/UX Specification

Design system and screen specification · as of Oct 8, 2026 · prepared for @Dharmaraj Sunil Aparadh

## Design philosophy

**Rocky should feel like a calm colleague who keeps a ledger.** It is quiet, unhurried and exact. It tells you what it is about to do, does it, and leaves a receipt you can check. The user should come away feeling in control and informed, never impressed by magic.

This spec rests on [Report 3](https://claude.ai/code/artifact/d9e5334a-7f62-43aa-88ac-ef44418bf184) (what Grok Bot, Muse and Dots do well and badly) and on the Rocky brief (palette, fonts, soft material, local web UI plus CLI, approval queue that currently shows raw JSON, no activity view, no mobile).

### What users should feel

- **In charge.** Boundaries are visible: what Rocky may touch, what it will ask about, what it can never do.
- **Informed.** Every action leaves a one-line receipt. Nothing important happens off-screen.
- **Unhurried.** No urgency tricks, no streaks, no exclamation marks. Rocky waits for you.
- **At home.** Warm, soft and a little literary, not a black hacker console.

### Vocabulary used throughout

| Word | Meaning in the UI |
| --- | --- |
| **Rocky** | The one assistant the user talks to. One name, one face (the pebble). |
| **Run** | One execution of a task. It has steps, receipts and a status. |
| **Worker** | A specialised helper Rocky starts inside a run (Browser, Research, Files, Code). Shown as a small chip, never as a separate chat. |
| **Receipt** | The one-line, checkable result of an action. |
| **Ledger** | The full, ordered activity log. Receipts are its summary. |
| **Boundary** | A permission: a folder, site or tool, with a level (read, write, send, delete). |
| **Pebble** | The avatar and state indicator. |

The shape is **one face, many hands**: the user always talks to Rocky; the hands appear as chips on the run. That avoids Grok's roster-of-bots overload and Dots' one-thread-for-everything problem.

### What makes Rocky recognisable

1. **Cool and warm have jobs.** Warm (blush, rose, cocoa) is you and your decisions; cool (periwinkle, slate) is Rocky and its work. A user's message is blush, Rocky's is periwinkle, an approval request is blush-tinted because it is about you.
2. **A serif voice on a calm canvas.** Instrument Serif for page titles and empty states only; Inter for everything you read or click; JetBrains Mono for payloads and paths.
3. **The pebble.** A smooth, slightly irregular stone shape that carries identity colour and state (resting, working, waiting). It is the one illustration Rocky needs.
4. **The receipt line.** Tool, verb, count, what did not happen. Rocky's signature component.
5. **A visible ledger.** Anyone can open the log, the memory and the approvals as plain files.

### How it differs from the five it will be compared with

| Product | Its default feel | Rocky's deliberate difference |
| --- | --- | --- |
| ChatGPT and Claude | Neutral chat, hidden tools | Work is a first-class object (runs, receipts), and chat is only one view of it |
| Grok Bot | Dark, roster of bots, shared cloud computer | Light-first and warm; one face; your own machine, with boundaries shown |
| Muse | Lifestyle brand, trust claims in prose | Trust shown on screen: the approval dialog and memory files are the hero |
| Dots | Colourful identity, hosted inside other apps | Own interface, own ledger; identity colour kept separate from state colour |

### Honest constraints on the look

- **The soft, raised (neumorphic) material from the website is for decoration only.** Raised-on-raised shapes have a measured contrast near 1.2:1 against the canvas, which fails the 3:1 needed to see a control's edge. Use it for the pebble, empty-state objects and the landing page. Controls get flat fills with a visible border.
- **Pastel red alone is not readable.** #E67E7F on the canvas measures 2.36:1. It is a fill with dark ink on top (5.81:1), never text or a thin icon on its own.
- **Density over decoration.** Rocky is a work tool. The app uses a 15px base and compact rows; softness lives in radii and warm neutrals, not in padding.

## Design language and tokens

Tokens come in three tiers so the app, the website and a future theme can share them: **primitive** (raw values, `--rocky-cocoa-500`), **semantic** (jobs, `--color-text-muted`), **component** (`--button-bg`). Components read only semantic and component tokens. Themes switch with `data-theme="light|dark"` on the root, defaulting to the system setting, with a manual override in Settings. Contrast ratios below were computed (WCAG 2.x), not guessed.

### Colour: brand primitives (from the brief)

| Name | Hex | Role in the app |
| --- | --- | --- |
| Periwinkle | #D0D9E6 | Hairlines, selected rows, Rocky's message tint, chips |
| Blush | #F2D3D3 | The user's message tint, soft highlights |
| Rose | #EDB0B1 | Secondary accent, links and focus accents on dark |
| Pastel red | #E67E7F | Primary button fill only (ink text on top, 5.81:1) |
| Cocoa | #915E56 | Links and secondary emphasis (4.58:1 on canvas, 5.06:1 on raised) |
| Ink | #2E1E1C | Primary text (13.7:1 on canvas) |

### Colour: semantic tokens

| Token | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--color-canvas` | #EAEEF4 | #1A110F | App background |
| `--color-surface` | #F8F9FB | #261816 | Cards, panels, inputs |
| `--color-surface-2` | #F1F4F8 | #31201D | Sidebar, table headers, nested panels |
| `--color-needs-you` | #F8E9E9 | #3A2321 | Tint for anything waiting on the user |
| `--color-text` | #2E1E1C | #F4ECEA | 13.7:1 and 15.9:1 |
| `--color-text-2` | #50342F | #D8C8C4 | Secondary text |
| `--color-text-muted` | #6B5651 | #B9A39E | 5.9:1 on canvas; 7.8:1 on dark canvas. The lowest text colour allowed. |
| `--color-border` | #D0D9E6 | #3D2A26 | Decorative hairlines only |
| `--color-border-strong` | #8C7F82 | #8A726D | Input and control edges; 3.3:1 light, 3.8:1 dark (meets the 3:1 rule for controls) |
| `--color-accent` | #E67E7F | #E67E7F | Primary button fill |
| `--color-accent-text-on` | #2E1E1C | #1A110F | On the accent fill; 5.8:1 and 6.8:1 |
| `--color-link` | #915E56 | #EDB0B1 | 4.6:1 and 10.1:1 |
| `--color-focus` | #5A3A34 | #EDB0B1 | 2px ring, 2px offset; 8.6:1 and 10.1:1 |
| `--color-agent` | #4A5F82 | #9DB8E8 | Rocky's own marks (pebble working, worker chips); 5.6:1 and 9.2:1 |

### Colour: status

Status is **never colour alone**. Every status pairs an icon and a word with the colour. Text and tint pairs below all measure 6.6:1 or better.

| Status | Text (light) | Tint (light) | Text (dark) | Icon |
| --- | --- | --- | --- | --- |
| Success | #1F5233 | #DDEFE3 | #8FD3A0 | check-circle |
| Warning (waiting, needs care) | #6B4500 | #F8EBCB | #F0C26B | alert-triangle |
| Error | #8F2427 | #F8DCDC | #FF9C9C | x-octagon |
| Info | #2C4A78 | #DCE6F5 | #9DB8E8 | info |

### Colour: agent identity swatches

Six fills for pebbles and worker chips, all with ink text above 8:1: Periwinkle #AFC0DD, Rose #EDB0B1, Sage #B7D3BE, Butter #EBD9A0, Lilac #CDBDE6, Peach #F0C8A8. **Rule:** identity colour decorates the pebble and the run's frame; it never carries a state. State always sits in a separate chip with an icon and a word. This avoids the trap where Dots-style identity colour and Grok-style state colour collide.

### Typography

| Style | Family | Size / line | Weight | Use |
| --- | --- | --- | --- | --- |
| display-xl | Instrument Serif | 56 / 60 | 400 | Landing hero only |
| display | Instrument Serif | 40 / 44 | 400 | Onboarding and empty-state headlines |
| title | Instrument Serif | 28 / 34 | 400 | Page titles (one per screen) |
| h2 | Inter | 20 / 28 | 600 | Section headings |
| h3 | Inter | 16 / 24 | 600 | Card and group headings |
| body | Inter | 15 / 24 | 400 | UI text, lists, forms |
| chat | Inter | 16 / 26 | 400 | Messages and long reading |
| small | Inter | 13 / 20 | 400 / 500 | Metadata, helper text, table cells |
| caption | Inter | 12 / 16 | 500 | Badges and timestamps. 12px is the floor; nothing is smaller. |
| mono | JetBrains Mono | 13 / 20 | 400 | Payloads, paths, commands, ids |

Weights are 400, 500 and 600 only. Serif never appears in controls, tables or chat messages. Numbers in tables and meters use tabular figures. Line length for chat is capped at 72 characters.

### Spacing, radius, shadow, border

| Group | Tokens |
| --- | --- |
| Spacing (4px base) | 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80 |
| Radius | 6 chips and inline code · 12 controls · 16 menus and list rows · 20 cards · 28 modals and panels · 999 pills and avatars (landing panels may go to 32–48) |
| Shadow (light) | `--shadow-1` 0 1px 2px rgba(46,30,28,.06), 0 2px 8px rgba(46,30,28,.05) for cards · `--shadow-2` 0 8px 24px rgba(46,30,28,.10) for popovers · `--shadow-3` 0 16px 48px rgba(46,30,28,.16) for modals |
| Shadow (dark) | Replace elevation with a 1px lighter top border plus the next surface step. No glow. |
| Soft material | `--shadow-soft` 6px 6px 14px rgba(163,177,198,.45), −6px −6px 14px rgba(255,255,255,.8). Decorative objects only (pebble, empty-state art). Never on a control. |
| Borders | 1px hairline for structure; 1px strong for controls; 2px focus ring offset 2px |

### Iconography, buttons, inputs, badges, avatars

- **Icons:** Lucide, outline, 1.5px stroke, sizes 16 / 20 / 24, inheriting text colour. Filled icons only for state (check-circle, alert-triangle). Every icon-only button has a tooltip and an accessible name.
- **Buttons:** 44px tall (36px dense variant inside tables, with a 44px hit area), radius 12, weight 600. Primary: accent fill, ink text, hover #EE9293, pressed #DE6F70. Secondary: surface fill with strong border. Tertiary: text only. Danger: #B3363A fill, white text (only for destructive confirms). One primary button per view.
- **Inputs:** 44px, radius 12, surface fill, strong border, visible label above, helper text below, error with icon and text. Never placeholder-only labels.
- **Cards:** surface fill, hairline border, radius 20, shadow-1, 16–24px padding. No card inside a card more than once.
- **Badges and status chips:** 24px pill, caption type, tint fill, icon plus word.
- **Avatars:** the user is a circle (initial or photo). Rocky and its workers are pebbles: a squircle with a gentle asymmetry in the identity colour, sizes 20 / 24 / 32 / 40 / 64.

### Motion principles

| Principle | Rule |
| --- | --- |
| Motion explains state | Animate only to show a change (a step finishing, a card arriving), never to decorate |
| Durations | 120ms micro (hover, press) · 200ms UI (menus, chips) · 320ms panels and sheets · 500ms landing only |
| Easing | Standard cubic-bezier(.2, 0, 0, 1); exit cubic-bezier(.4, 0, 1, 1) |
| Cheap properties | Transform and opacity only. No blur on anything that repeats. |
| Working is slow | The pebble breathes on a 2.4s loop. No spinners on the main surface; skeletons for lists, a text status for waits. |
| Streaming | New text and new events fade in over 120ms and append in place; no typewriter delay |
| Reduced motion | Replace all movement with instant or opacity-only changes; the breathing pebble becomes a static ring with a label |

## Core screens 1 to 8

### App shell (applies to screens 4 to 20)

Desktop: a collapsible left sidebar (240px, collapses to a 64px icon rail), a main area, and an optional right work pane (420–560px). Sidebar groups: **Today**, **Approvals** (count badge), **Projects**, **Tasks**; then **Library**: Memory, Files, Integrations; footer: Notifications, Help, Settings, profile. A command palette (Ctrl/Cmd+K) reaches everything. Rocky's pebble and a state chip sit at the top of the sidebar so the agent's state is visible on every screen.

### 1. Landing page

| Field | Spec |
| --- | --- |
| Purpose | Explain Rocky in ten seconds and get a builder to install it. |
| Layout | Single column, 1120px container. Hero, three proof sections, install block, short open FAQ, footer. |
| Components | Wordmark nav (Docs, GitHub, Install); hero with a live demo built from real app components (an approval card and a receipt list on a loop); proof rows for approvals, memory files and local-first; install block with OS tabs and copy button; FAQ as plain text, not accordions. |
| Navigation | Sticky top bar; in-page anchors; footer links to docs, licence, issues. |
| Primary CTA | "Install Rocky" (scrolls to the install block). |
| Secondary actions | "View on GitHub", "Read the docs", "Watch the 60-second loop". |
| Information hierarchy | Promise, then proof (the real approval card), then how to install, then who it is for and what it will not do. |
| Important interactions | The demo can be paused and has a static fallback; the copy button confirms with a toast; tabs switch OS commands. |
| Loading state | Static HTML and CSS, no skeletons. The demo mounts after first paint. |
| Empty state | Not applicable. |
| Error state | If the demo fails to mount, show the same content as a still image with alt text; the page still works. |
| Responsive behavior | Single column under 768px; the demo scales to full width; code blocks scroll horizontally; CTA full width at 44px+ tall. |

### 2. Sign-up and login (local unlock)

Rocky is local-first, so there is no account wall at launch. This screen is an unlock screen, shown only if the user set a passcode or the engine needs the OS keychain. An optional account for sync can come later; do not build it now.

| Field | Spec |
| --- | --- |
| Purpose | Confirm the person at the keyboard is the owner, then open Rocky. |
| Layout | Centred 420px panel on canvas. Pebble, serif title "Welcome back", one input, one button. |
| Components | Pebble avatar, passcode input with show/hide, "Use system login" button, a quiet line: "Everything stays on this computer." |
| Navigation | None. Escape does nothing. A small "Forgot passcode" link explains the reset (it clears the lock, not the data). |
| Primary CTA | "Open Rocky". |
| Secondary actions | "Use system login", "Forgot passcode". |
| Information hierarchy | Title, input, button, reassurance. |
| Important interactions | Enter submits; focus lands in the input; paste is allowed; failed tries show a remaining count and a short lockout timer. |
| Loading state | Button shows "Opening…" and is disabled; the panel stays still. |
| Empty state | Not applicable. |
| Error state | "That passcode didn't work. 3 tries left." with an error icon; after the last try, a countdown. Engine unreachable: "Rocky isn't running. Start it" with the command and a Retry button. |
| Responsive behavior | Panel becomes full width below 480px, button sticks to the bottom above the keyboard. |

### 3. Onboarding

| Field | Spec |
| --- | --- |
| Purpose | Get a first useful task running in about two minutes, with boundaries the user chose. |
| Layout | Centred 560px column with a four-step progress line ("Step 2 of 4"). Back link top left. |
| Components | Step 1 name your Rocky and pick an identity swatch with a live pebble preview. Step 2 choose a model (local model detected, or API key with a Test button). Step 3 choose what Rocky may touch (folders, browser, shell, all off by default) with three presets: Ask about everything, Ask about risky things, Read only. Step 4 three starter tasks that work within the chosen boundaries. |
| Navigation | Continue and Back; progress is saved so closing the tab resumes at the same step. Skip is available on steps 1 and 4. |
| Primary CTA | "Continue" (step 4: "Start first task"). |
| Secondary actions | "Skip for now", "Back", "What does this allow?" (opens a plain-language drawer). |
| Information hierarchy | One decision per step; the consequence of the choice is written under it. |
| Important interactions | The Test connection button gives a specific result (key invalid, host unreachable, model missing). The permission step shows a live sentence: "Rocky can read files in \~/notes and ask before changing them." |
| Loading state | Test connection shows an inline status line; starter tasks load as three skeleton cards. |
| Empty state | If no local model is found, step 2 leads with the API key option and a link to setup docs. |
| Error state | Failed test keeps all entries, explains the cause, and offers "Continue without a model" only in read-only demo mode. |
| Responsive behavior | Single column on all sizes; sticky bottom action bar on mobile. |

### 4. Main dashboard ("Today")

| Field | Spec |
| --- | --- |
| Purpose | The morning-after view: what needs me, what is running, what finished while I was away. |
| Layout | Main column (max 760px) plus a 320px right column. Composer pinned at the top of the main column. |
| Components | Composer, "Needs you" list of approval cards (first three inline), "Running" task cards with live status, "Finished since you left" grouped receipt summaries; right column: Rocky status panel, "Learned recently" (memory notices), next scheduled routine. |
| Navigation | Sidebar; cards open the task or the approval; "See all" links go to Approvals and Tasks. |
| Primary CTA | The composer's send button ("Ask Rocky"). When something needs the user, "Review (3)" becomes the first button in the page header. |
| Secondary actions | Approve or Deny inline, "Open task", "Dismiss" for finished items, "New routine". |
| Information hierarchy | Needs you, then Running, then Finished, then context. Anything waiting on the user always sits above anything Rocky is doing. |
| Important interactions | Approve and Deny work inline with a visible Undo for 10 seconds where the action allows it; finished items collapse into a one-line summary with an expand control. |
| Loading state | Three section skeletons that match the final row heights so nothing jumps. |
| Empty state | Serif line "Nothing needs you." with three starter prompts built from the user's projects. |
| Error state | Page banner: "Rocky's engine isn't responding." with Restart, View log, and last-seen time. Content below stays visible but dimmed and read-only. |
| Responsive behavior | Right column folds into a collapsible strip under the header; single column below 900px; Needs you stays first. |

### 5. AI chat and workspace

| Field | Spec |
| --- | --- |
| Purpose | Converse with Rocky inside a project and watch the work it starts. |
| Layout | Conversation column (max 720px reading width) beside a collapsible work pane (420–560px) with tabs Activity, Browser, Files, Memory. |
| Components | Message list (user in blush, Rocky in periwinkle), inline run cards, receipt lines, approval cards, memory notices, composer with attachments, @file and @worker mentions, a permission chip ("Ask about risky things") and a model chip. |
| Navigation | Project breadcrumb at the top; Ctrl/Cmd+K; the work pane follows the selected run. |
| Primary CTA | Send (Enter). While a run is active, Stop takes over as the primary control and Send moves to Enter-to-queue. |
| Secondary actions | Attach, slash commands, edit last message, branch from here, copy, pin a message to memory. |
| Information hierarchy | The latest message, then the current run card, then receipts, then older history. |
| Important interactions | Typed event stream (message, status, receipt, approval, memory, error); Up arrow edits the last message; Shift+Enter newline; Esc closes the work pane or menu first, never stops a run; Ctrl/Cmd+. stops the run. |
| Loading state | History loads as skeleton bubbles; a send shows the user bubble instantly and a "Rocky is thinking" chip. |
| Empty state | Serif greeting, three starter chips from the project, and a one-line summary of the boundaries in force. |
| Error state | A failed send keeps the draft and shows "Couldn't send. Retry or Copy message" under it. A broken stream shows "Connection lost. Reconnecting…" and replays missed events. |
| Responsive behavior | Work pane becomes a full-screen sheet; composer sticks above the keyboard; run cards stay inline. |

### 6. Agent and task creation

| Field | Spec |
| --- | --- |
| Purpose | Define a one-off task or a reusable routine, with its boundaries, before anything runs. |
| Layout | A right-hand drawer (560px) from the composer's "Set up a task" or from Tasks, not a multi-page wizard. |
| Components | Goal textarea; Boundaries section (folders, sites, tools as chips with level badges); Approval policy selector; Schedule (once, daily, weekly, on an event); Budget (time, steps, cost); a "What Rocky will be allowed to do" preview card in plain language. |
| Navigation | Opens over the current screen; closes without losing the draft. |
| Primary CTA | "Start task" (or "Save routine"). |
| Secondary actions | "Show me the plan first" toggle (on by default for new boundaries), "Save as draft", "Duplicate from a past task". |
| Information hierarchy | Goal first; boundaries shown as a one-line summary that expands; the preview card last, just above the button. |
| Important interactions | Adding a folder outside current boundaries shows "Rocky can't touch \~/Documents yet. Allow read only?" inline. The preview updates as the user edits. |
| Loading state | Plan generation shows three skeleton step rows and a "Planning…" status. |
| Empty state | Template cards: Summarise a folder, Watch a page, Draft replies. |
| Error state | Field-level errors with icon and text; a plan that cannot be made says why and what to change. |
| Responsive behavior | Full-screen sheet with a sticky footer button. |

### 7. Running task screen

| Field | Spec |
| --- | --- |
| Purpose | Follow one run from start to finish and step in if needed. |
| Layout | Header (title, status chip, elapsed time, Pause and Stop), step timeline in the main column, detail pane on the right. |
| Components | Status header, step timeline with receipts, approval cards, a "Tell Rocky something" input, a take-over bar when a browser is involved, a cost and step meter. |
| Navigation | Back to Tasks; the right pane shows the selected step's payload, output or browser frame. |
| Primary CTA | Depends on state: Stop while running; Approve while waiting; Retry from here when failed; Open results when done. |
| Secondary actions | Pause, Add instruction, Copy link to this run, Re-run, Export log. |
| Information hierarchy | Status and what it is doing now, then the steps, then receipts, then raw detail. |
| Important interactions | Expanding a step reveals its tool call and payload in mono; adding an instruction appears as a user event in the timeline; keyboard J/K moves between steps. |
| Loading state | Skeleton timeline with the first step already labelled "Planning". |
| Empty state | Not applicable; a run always has a first step. |
| Error state | The failed step opens automatically with three lines: what happened, what Rocky already tried, what you can do. Actions: Retry this step, Retry from here, Ask Rocky to fix it, Stop. |
| Responsive behavior | Timeline only; step detail opens in a bottom sheet; header collapses to title plus status. |

### 8. Agent activity and live execution view (the ledger)

| Field | Spec |
| --- | --- |
| Purpose | The complete, ordered record of what Rocky did, planned and was blocked from doing. |
| Layout | Full-width timeline with a time rail on the left, filters on top, payload drawer on the right. |
| Components | Event rows (plan, thought summary, tool call, action, result, approval, memory, error), filter chips by worker, type and status, search, a Follow live toggle, a payload drawer. |
| Navigation | Reached from any run, from the Rocky status panel, and from the work pane's Activity tab. |
| Primary CTA | "Follow live". |
| Secondary actions | Export as JSON or Markdown, copy link to an event, "Undo this" where the action is reversible, "Make a rule from this". |
| Information hierarchy | Action and target first, result second, worker and time muted. Planned actions are shown in an outlined style until they happen. |
| Important interactions | Virtualised list; J/K to move, Enter opens the payload; filters persist per project; live mode auto-scrolls and pauses when the user scrolls up. |
| Loading state | Skeleton rows at the real row height. |
| Empty state | "No activity yet. Anything Rocky does will show up here." |
| Error state | "Live updates stopped. Reconnecting…" with a Replay missed events button once back. |
| Responsive behavior | Single list; filters collapse to a sheet; payload opens full screen. |

## Core screens 9 to 16

### 9. Browser and computer-use view

| Field | Spec |
| --- | --- |
| Purpose | Let the user watch what Rocky is doing in a browser or on screen, and take over when needed. |
| Layout | A viewport frame in the work pane (or full screen), a read-only address bar above it, a control banner below it, and the last five actions listed beside or under it. |
| Components | Viewport showing streamed frames; control banner ("Rocky is in control" or "You are in control") with a pebble or avatar; a cursor overlay labelled "Rocky" or "You"; a caption line for the current step; snapshot strip. |
| Navigation | Opens from a browser step in the timeline or from the work pane's Browser tab. |
| Primary CTA | "Take over" while Rocky is in control; "Hand back to Rocky" while the user is. |
| Secondary actions | Pause, Save snapshot, Open this page in my browser, Block this site. |
| Information hierarchy | The frame, then who holds control, then the caption, then the action list. |
| Important interactions | Input is disabled by default so a stray click cannot change the page; Take over enables it and turns the banner blush-tinted for "You". When Rocky reaches a sign-in, an amber banner reads "Rocky stopped at a sign-in. Sign in, then continue." with a Continue button (the pattern Grok Bot gets right). Typed secrets never enter the log. |
| Loading state | An outlined frame with "Starting the browser…" and no spinner. |
| Empty state | "Rocky isn't using a browser right now." with a link to the last session's snapshots. |
| Error state | "The browser closed unexpectedly." with Reopen, View log, and the last good snapshot kept on screen. |
| Responsive behavior | Full-screen viewer with a floating control chip; read-only by default on phones. |

### 10. Task history

| Field | Spec |
| --- | --- |
| Purpose | Find any past run, see what it did, and run it again. |
| Layout | Page title, filter bar (status, project, worker, date), search, then a table. |
| Components | Table with columns Title, Status chip, Project, Started, Duration, Outcome (receipt count and one-line result), Cost; row actions menu; saved filters. |
| Navigation | Sidebar > Tasks > History. A row opens the run page. |
| Primary CTA | "New task". |
| Secondary actions | Re-run, Duplicate as routine, Export, Archive. Delete is a soft delete with Undo. |
| Information hierarchy | Title and status, then outcome, then metadata. |
| Important interactions | Sort by any column; select several rows for bulk archive; search covers titles and receipts; J/K and Enter on rows. |
| Loading state | Ten skeleton rows at the real row height. |
| Empty state | Serif "No tasks yet." with the three template cards from task creation. |
| Error state | "Couldn't read the history." with Retry and Repair (re-index the local store). |
| Responsive behavior | Table becomes a card list with title, status and outcome; filters open in a sheet. |

### 11. Background tasks

| Field | Spec |
| --- | --- |
| Purpose | See what runs while the user is away and keep it under control. |
| Layout | Three tabs: Running, Scheduled (routines), Paused or waiting. A card grid or list beneath. |
| Components | Routine card with name, schedule in words ("Weekdays at 8:00"), next run, last result, a health strip of the last five runs, a Pause/Resume switch and "Run now"; a waiting card that links to its approval. |
| Navigation | Sidebar > Tasks > Background. Cards open the run or the routine settings. |
| Primary CTA | "New routine". |
| Secondary actions | Run now, Pause all, Edit schedule, Notification settings for this routine. |
| Information hierarchy | Anything stuck or waiting first, then running, then healthy and idle. |
| Important interactions | A routine that fails three times in a row pauses itself and moves to the top with a warning; "Pause all" is a single visible control with a confirm. Quiet hours are respected for notifications but not for work. |
| Loading state | Skeleton cards. |
| Empty state | "Nothing runs while you're away." with one example routine to try. |
| Error state | A routine card turns warning-tinted with the cause and a Fix button; the engine being down shows the same banner as the dashboard. |
| Responsive behavior | Cards stack one per row; the health strip stays on one line. |

### 12. Projects and workspaces

| Field | Spec |
| --- | --- |
| Purpose | Scope files, memory, rules and runs to one piece of work. |
| Layout | List page of project cards; a project page with tabs Overview, Chat, Tasks, Files, Memory, Rules. |
| Components | Project card (name, folder path, last activity, running count, needs-you count), project header with a boundaries summary, tab bar, the same chat and task components used elsewhere. |
| Navigation | Sidebar > Projects; a project switcher in the breadcrumb; Ctrl/Cmd+P opens it. |
| Primary CTA | "New project" (pick a folder, name it). |
| Secondary actions | Rename, Change folder, Archive, Duplicate rules from another project. |
| Information hierarchy | Name and needs-you count first, then what is running, then folder and last activity. |
| Important interactions | Creating a project shows its default boundaries (read and ask) before it opens; rules set in a project override global defaults and the project header shows that. |
| Loading state | Skeleton cards. |
| Empty state | "Pick a folder to start." with a Browse button and a note that Rocky can't see it until you do. |
| Error state | "This folder moved or was deleted." with Locate, Remove from Rocky, and Keep history. |
| Responsive behavior | Cards become a list; tabs become a scrollable segmented bar. |

### 13. Memory

| Field | Spec |
| --- | --- |
| Purpose | Let the user read, edit and forget everything Rocky remembers. |
| Layout | Two panes. Left: a searchable list grouped as About you, Projects, Preferences, Learned this week. Right: the selected memory as an editable Markdown file. |
| Components | A "Learned this week" banner with Accept, Edit, Forget on each item; provenance line (where it was learned, when, in which run); "Used in" list; a disable-for-this-project switch; an inline diff when Rocky proposes a change. |
| Navigation | Sidebar > Library > Memory. Memory notices in chat deep-link to the entry. |
| Primary CTA | "Edit" on the selected entry (or "Accept" on a new learning). |
| Secondary actions | Forget, Export as Markdown files, Pin so Rocky always reads it, Disable for a project. |
| Information hierarchy | New learnings first, then the selected file, then provenance. |
| Important interactions | Rocky proposes memory changes as a diff the user accepts, never silently overwrites; Forget is a soft delete with a 10-second Undo toast; the files live on disk and the page says where. |
| Loading state | Skeleton list and a skeleton editor. |
| Empty state | "Rocky hasn't learned anything yet. It will ask before it saves anything." |
| Error state | If the file changed on disk while open: "This file changed." with a side-by-side diff and Keep mine, Take theirs, Merge. |
| Responsive behavior | List first; selecting an entry pushes the editor as a full screen with a back arrow. |

### 14. Files

| Field | Spec |
| --- | --- |
| Purpose | Show every file Rocky read, created or changed, so nothing happens to the user's files without a trace. |
| Layout | Filter chips (Read, Created, Changed, Deleted), a table, a preview drawer on the right. |
| Components | Table with Name, Path, Action, Task, Time, Size; preview for text, Markdown, images and diffs; a Revert button where a snapshot exists. |
| Navigation | Sidebar > Library > Files; reached from a receipt that mentions a file. |
| Primary CTA | "Open in folder". |
| Secondary actions | Copy path, Revert change, Open the run that touched it, Exclude this folder. |
| Information hierarchy | Action and name first, then task and time, then path and size. |
| Important interactions | Changed files open as a diff by default; reverting shows exactly what will be restored before it happens; large files preview as metadata only. |
| Loading state | Skeleton rows; the preview shows a placeholder block. |
| Empty state | "Rocky hasn't touched any files." |
| Error state | A row whose file is gone is greyed with "No longer on disk", and its actions are disabled except "Open the run". |
| Responsive behavior | List view; the preview opens as a full-screen sheet. |

### 15. Integrations

| Field | Spec |
| --- | --- |
| Purpose | Connect tools to Rocky and set exactly what each may do. |
| Layout | Grid of integration cards (Connected first, then Available); a detail drawer for the selected one. |
| Components | Card (icon, name, status chip, last used); drawer with a permissions matrix (rows: Read, Write, Send, Delete by scope; cells: Allow, Ask, Block), Test connection, activity count, Disconnect; an "Add a tool server" section for developers. |
| Navigation | Sidebar > Library > Integrations. |
| Primary CTA | "Connect". |
| Secondary actions | Test, View activity, Disconnect, Edit permissions. |
| Information hierarchy | What is connected and healthy, then what needs attention, then what is available. |
| Important interactions | Every permission cell defaults to Ask; changing one to Allow shows a plain-language preview of what that lets Rocky do; credentials are stored by the OS keychain or an encrypted file and are never shown again after entry. |
| Loading state | Skeleton cards; Test connection shows an inline status line. |
| Empty state | "No tools connected. Rocky can still use the files and browser you allow." |
| Error state | An expired login turns the card warning-tinted with a single Reconnect button; a failing tool shows the last error in the drawer. |
| Responsive behavior | One column; the drawer becomes a full-screen sheet. |

### 16. Notifications

| Field | Spec |
| --- | --- |
| Purpose | Tell the user the few things worth interrupting them for, and keep a record of the rest. |
| Layout | A bell popover (last ten) and a full page with tabs Needs you, Updates, All; a Preferences tab. |
| Components | Notification row (type icon, one sentence, time, one action), unread dot, preference matrix of event type by channel (in-app, system notification, optional phone notification). |
| Navigation | Bell in the sidebar footer; the full page from the popover's "See all". |
| Primary CTA | "Mark all as read". |
| Secondary actions | Open the item, Snooze, Change preferences. |
| Information hierarchy | Needs you above everything; updates grouped by day. |
| Important interactions | Approval notifications offer "Review" only, never Approve, so a glance cannot approve an action; quiet hours silence the system channel but keep the in-app record. |
| Loading state | Skeleton rows. |
| Empty state | "You're caught up." |
| Error state | If the OS blocks notifications, a banner explains how to allow them for this app and offers a test button. |
| Responsive behavior | Full-page list on small screens; the bell moves into the More tab. |

## Core screens 17 to 23

### 17. Approvals

This is the screen that decides whether Rocky is trustworthy, and the one every competitor describes but none shows. The brief says the current queue shows raw JSON; the design below keeps the JSON but demotes it.

| Field | Spec |
| --- | --- |
| Purpose | Let the user decide on proposed actions quickly, with enough evidence to say yes or no correctly. |
| Layout | Queue on the left (grouped by task, oldest and riskiest first), detail on the right. |
| Components | Queue row (action sentence, task, age, risk chip); detail card with: **the action in one sentence** ("Send an email to Dana Lee"), **what will change** (a rendered preview or diff), **why** (Rocky's one-line reason), **scope and risk chip** (reads, writes, sends, spends, deletes), **policy line** ("No rule matched"), a collapsed **raw payload** in mono; button group. |
| Navigation | Sidebar > Approvals; notification "Review" buttons; inline cards on the dashboard and in chat deep-link here. |
| Primary CTA | "Approve". |
| Secondary actions | "Edit, then approve", "Deny" with an optional note sent back to Rocky, "Always allow actions like this" (opens a rule preview; it is never the default and sits apart from the main buttons). |
| Information hierarchy | The sentence, then what changes, then risk, then why, then policy, then payload. |
| Important interactions | The card is drawn by Rocky's own client code from the structured action, never from text the model wrote, so the model cannot reword its own request (the principle behind Muse's separate approval surface). High-risk actions (send, spend, delete) need a deliberate second step: focus moves to a confirm field, and Enter on the queue never approves. J/K moves through the queue, A and D act only when the buttons have focus. Approvals expire with the task. |
| Loading state | Skeleton queue and a skeleton detail card. |
| Empty state | "Nothing is waiting for you." with a link to the ledger. |
| Error state | "This request expired" or "The task ended before you answered" turns the card read-only with the reason. A failed approval shows "Couldn't send your answer. Retry" and keeps the card open. |
| Responsive behavior | Queue then detail as a full-screen sheet; Approve and Deny are large sticky buttons; the raw payload stays collapsed. |

### 18. Settings

| Field | Spec |
| --- | --- |
| Purpose | Change how Rocky works, with the risky settings kept visible and reversible. |
| Layout | Left list of categories, content on the right. Categories: General, Model, Permissions and rules, Memory, Notifications, Appearance, Privacy and data, Advanced, About. Integrations has its own screen and is linked. |
| Components | Setting row (label, one line of help, control); search across settings; rules editor (allow, ask, block, always-with-you); data location with Open folder; log level; port and engine controls under Advanced. |
| Navigation | Sidebar footer; Ctrl/Cmd+, ; the command palette searches settings by name. |
| Primary CTA | None. Settings apply immediately with a toast and Undo; destructive changes use a confirm. |
| Secondary actions | Reset to default per section, Export settings, Open config file. |
| Information hierarchy | Safety (permissions and rules) is the second item, directly under General, not buried. |
| Important interactions | A rule shows a plain-language preview ("Rocky will send email to people in your contacts without asking") before it saves; changing a rule from Ask to Allow shows how many past approvals it would have skipped. |
| Loading state | Skeleton rows per section. |
| Empty state | A rules list with no rules reads "No custom rules. Rocky asks before risky actions." |
| Error state | A setting that fails to save reverts with an inline message and a Retry. |
| Responsive behavior | Category list then a pushed detail screen. |

### 19. Profile

| Field | Spec |
| --- | --- |
| Purpose | Tell Rocky who you are and shape who Rocky is. |
| Layout | Two tabs: **You** and **Rocky**. |
| Components | You: display name, how Rocky should address you, avatar, time zone, language, working hours. Rocky: name, identity swatch with live pebble preview, a one-slider tone control (brief to chatty), a link to "About you" memory. |
| Navigation | Avatar in the sidebar footer. |
| Primary CTA | "Save" (the only settings-like screen with an explicit save, because the preview should be reviewed). |
| Secondary actions | Discard changes, Reset Rocky's name and colour. |
| Information hierarchy | Name and avatar first; time zone and hours affect notifications and routines, so they come next. |
| Important interactions | Changing Rocky's colour updates the pebble live in the sidebar preview; time zone defaults to the system and shows a sample time. |
| Loading state | Skeleton fields. |
| Empty state | Not applicable. |
| Error state | Inline validation with icon and text; a failed save keeps the form. |
| Responsive behavior | Single column; the Rocky tab's preview sits above the controls. |

### 20. Help and documentation

| Field | Spec |
| --- | --- |
| Purpose | Get the user unstuck without leaving the app. |
| Layout | Search-first page with category cards (Start here, Approvals and safety, Memory, Integrations, Troubleshooting) and a persistent "Run diagnostics" button. |
| Components | Search field, category cards, article view, "Run diagnostics" (engine, model, permissions, disk), "Copy debug info" (secrets redacted), keyboard shortcut sheet (press ?). |
| Navigation | Sidebar footer; F1 or ?; deep links from error states open the exact article. |
| Primary CTA | Search. |
| Secondary actions | Run diagnostics, Copy debug info, Report an issue (opens the repository's issue page with the info pre-filled, never sent automatically). |
| Information hierarchy | Search, then the three most common problems, then categories. |
| Important interactions | Docs ship inside the app so they work offline; the shortcut sheet is searchable. |
| Loading state | Articles are local, so no skeleton; search results appear as the user types. |
| Empty state | "No results. Try fewer words or run diagnostics." |
| Error state | If a linked online page is unreachable, show the bundled copy. |
| Responsive behavior | Cards stack; article view is a pushed screen. |

### 21. Error states (system)

One pattern, four containers. **Pattern:** icon, a plain title, what happened in one sentence, what Rocky already did, one primary fix action, and a "Details" link that reveals the log excerpt and error code. Never lead with a code; never blame the user.

| Case | Container | Title and fix |
| --- | --- | --- |
| Engine not running | Page banner | "Rocky isn't running." Restart |
| Model unreachable or key rejected | Banner plus inline in the composer | "Can't reach the model." Check connection, Switch model |
| A step failed | Expanded step in the run | "This step failed." Retry this step |
| Permission blocked | Inline in the run | "Rocky isn't allowed to write to this folder." Allow once, Change boundary |
| Integration login expired | Card state | "Needs you to sign in again." Reconnect |
| Approval expired | Read-only card | "This request expired." Ask Rocky to try again |
| Disk or write failure | Toast plus ledger entry | "Couldn't save to disk." Open folder, Free space |
| Unexpected UI crash | Full page (error boundary) | "Something broke on this screen." Reload, Copy details |

### 22. Empty states (system)

Every empty state has one serif headline of up to six words, one sentence on what will appear and why, one action, and (optionally) a small preview of the filled state. Never an illustration with no action.

| Screen | Headline | Action |
| --- | --- | --- |
| Today | Nothing needs you. | Ask Rocky something |
| Chat | Start with a task. | Three starter chips |
| Task history | No tasks yet. | New task |
| Background | Nothing runs while you're away. | New routine |
| Projects | Pick a folder to start. | New project |
| Memory | Nothing remembered yet. | Learn how Rocky asks first |
| Files | No files touched. | Open a project |
| Integrations | No tools connected. | Connect a tool |
| Notifications | You're caught up. | None |
| Approvals | Nothing is waiting. | Open the ledger |

### 23. Mobile experience

A phone is for checking in, approving and nudging. It is not where a browser gets driven. Because Rocky is local, the phone connects to the user's own computer over the home network or a free private network such as Tailscale; no hosted backend is needed.

| Field | Spec |
| --- | --- |
| Purpose | See what is running, approve or deny, and send a short instruction while away from the desk. |
| Layout | Bottom tab bar: Today, Approvals (badge), Tasks, Chat, More. Full-screen sheets for details. |
| Components | Today list, approval card with large Approve and Deny buttons, run page with timeline only, chat with sticky composer, a read-only browser snapshot viewer. |
| Navigation | Tab bar; swipe back; the sheet drag handle closes details. |
| Primary CTA | Depends on the tab: Approve on Approvals, Send on Chat, Open on Today. |
| Secondary actions | Pause all, Stop a run, Snooze notifications. |
| Information hierarchy | Needs you, then running, then finished, always in that order. |
| Important interactions | Touch targets at least 44px; Approve for high-risk actions uses a press-and-hold; notifications (through a free self-hostable service such as ntfy) open the exact approval; biometric unlock where the browser allows it. |
| Loading state | Skeletons plus "Reaching your computer…". |
| Empty state | Same copy as desktop, shortened to one line. |
| Error state | "Can't reach your computer. It may be asleep." with the last-synced time and a Retry button. |
| Responsive behavior | Phone under 600px; tablet 600–900px uses the desktop shell with the sidebar as a rail and the work pane as a sheet. |

## Design-system component spec

Colours, type, spacing, radius and motion are in the tokens section. This section covers layout, then every component with when to use it and when not to. All components meet WCAG 2.2 AA, have a visible 2px focus ring, hit areas of at least 44px, and follow the reduced-motion rules.

### Layout, grid and breakpoints

| Item | Spec |
| --- | --- |
| Breakpoints | xs under 600 · sm 600–899 · md 900–1199 · lg 1200–1599 · xl 1600 and up |
| Grid | 12 columns; gutter 16px (24px from lg); page margin 16 / 24 / 32px at xs / md / lg |
| Containers | Reading 720px (chat, articles) · Content 960px (forms, settings) · Dashboard main 760px plus 320px side · Landing 1120px · App shell is fluid |
| Shell | Sidebar 240px (rail 64px) · work pane 420–560px, resizable, remembered per project |
| Rule | Below 900px the work pane and side column become sheets or stacked sections; below 600px the sidebar becomes a bottom tab bar |

### Controls and inputs

| Component | Spec | Use when | Don't use when |
| --- | --- | --- | --- |
| Button | Primary, secondary, tertiary, danger; 44px (36px dense); icon-only needs a tooltip and name | One clear action per view (primary); supporting actions (secondary) | Two primaries in one view; navigation (use a link); a toggle (use a switch) |
| Input | 44px, visible label, helper text, error with icon | Short single-line values | A label-less search (use the search field); long text (use a textarea) |
| Textarea | Min 3 rows, auto-grows to 10, character count only when limited | Goals, notes, rules in plain text | Chat composer (use the composer, which adds attachments and mentions) |
| Dropdown (select) | Native select for 7 or fewer simple options; custom listbox beyond that, with type-ahead | One choice from a known list | Fewer than 3 options (use radio or segmented); frequent switching (use tabs) |
| Selectors (radio, checkbox, switch, segmented) | Radio and segmented: one of few; checkbox: many; switch: instant on/off | A setting that applies immediately (switch) | A choice that needs a Save step (use checkbox); more than 4 segments |
| Tabs | Underlined, 44px high, arrow-key navigation, panels stay mounted state | Switching between views of the same object | Steps in an order (use a stepper); navigation between pages (use the sidebar) |
| Command palette | Ctrl/Cmd+K; one input; groups for Actions, Projects, Tasks, Settings; recent first; every result shows its shortcut | Power-user jump and action launcher | The only way to reach a feature; every command must also exist in the UI |

### Navigation and containers

| Component | Spec | Use when | Don't use when |
| --- | --- | --- | --- |
| Sidebar | 240px, collapsible to a 64px rail with tooltips; groups: primary, Library, footer; badge counts for Approvals | Top-level destinations (7 to 9 items) | Page-level filters; more than 9 destinations |
| Top bar / breadcrumb | Project switcher and title; right side holds the Rocky status chip | Showing where you are within a project | Repeating the sidebar |
| Card | Surface fill, hairline border, radius 20, shadow-1 | A self-contained object (task, project, integration) | Grouping unrelated fields (use a section); nesting more than one level |
| Modal | Radius 28, max 480px, focus trapped, Esc closes, primary button last | A short decision that blocks progress (confirm delete) | Forms with more than four fields; anything the user may need to look away from (use a drawer) |
| Drawer | 560px from the right (sheet on mobile), keeps the page visible | Creating or editing without losing context (task creation, payload detail) | Blocking confirmations; content longer than two screens (use a page) |
| Toast | 4s (8s with an action), bottom left, stacked, polite live region, always an Undo for reversible actions | Confirming a small completed action | Errors the user must act on (use an alert); approvals; anything that must persist |
| Alert / banner | Inline, icon plus text, info / success / warning / error, dismissible only when informational | A state of the page or system (engine down, key expired) | A one-time confirmation (use a toast) |
| Tooltip | On hover and keyboard focus, 500ms delay, 12px text, no interactive content | Naming an icon or explaining a shortcut | Essential information; touch screens (use visible text) |

### Data display

| Component | Spec | Use when | Don't use when |
| --- | --- | --- | --- |
| Table | Sticky header, 44px rows (36px dense), sortable columns, row selection, keyboard row navigation | Comparing many records on several attributes (history, files) | Fewer than 5 rows (use a list); mobile (becomes cards) |
| List | 52px rows, leading icon or avatar, one-line title, one-line meta | Simple scannable items (notifications, approvals queue) | Data needing columns |
| Avatar | User circle; Rocky and workers as pebbles; 20 / 24 / 32 / 40 / 64 | Showing who did something | Decoration; as the only indicator of state |
| Status indicator | 24px chip: icon, word, tint (colour tokens above); a 8px dot only inside dense rows beside text | State of a run, routine or connection | Colour alone; more than one status chip per row |
| Progress indicator | Determinate bar when steps are known ("Step 3 of 7"); otherwise a text status plus elapsed time; never a bare spinner on the main surface | Showing a run's position | Hiding that time is unknown |
| Skeleton | Matches the real row and card sizes, 1.2s fade between two tones, disabled under reduced motion | Lists, tables and cards loading for more than 300ms | Anything under 300ms; actions (use inline text) |

### Conversation and agent components

| Component | Spec | Use when | Don't use when |
| --- | --- | --- | --- |
| Chat message | User: blush tint, right-aligned; Rocky: periwinkle tint, left, pebble avatar on the first message of a group; 16/26 text, 72-character measure; hover reveals Copy, Edit, Branch, Pin to memory | Natural-language turns | System events (use an event row) |
| Composer | Multiline, auto-grows to 10 rows, attachment button, @ mentions for files and workers, permission and model chips, Send/Stop button | The one place to talk to Rocky | Forms with fixed fields |
| Run card | Inline in chat: title, status chip, current step in words, progress, workers as chips, Open and Stop buttons | Showing that a task started from a message | Long histories (open the run page) |
| Activity row | Time rail, worker chip, event type icon, action sentence, result, expand for payload | The ledger and run timeline | Chat |
| Receipt | One line: tool icon, tool, verb, result, count, what did not happen ("✓ Files → read 12 notes · 0 changed"); click opens the event | Every completed action | Failures (use an error step) |
| Tool-call block | Collapsed by default: tool name, target, duration; expanded: arguments and output in mono, with a Copy button | Developers and audit | The default view for non-technical users |
| Worker chip | Pebble, name, state dot with a word on hover; max 4 shown, then "+n" | Showing which helper is working | As a navigation item |
| Approval card | Action sentence, change preview or diff, risk chip, why line, policy line, collapsed raw payload, Approve / Edit / Deny; blush-tinted; drawn by trusted client code from structured data | Any action that needs a decision | Informational updates |
| Take-over bar | Banner naming who holds control with one button to switch; amber when Rocky is blocked | Browser and computer-use steps | Non-interactive tool calls |
| Memory notice | Inline card: "Noted for next time:" the fact in plain words, source, Edit and Forget | When Rocky saves or proposes a memory | Repeating on every small fact (batch at the end of a run) |
| File chip / file row | Icon by type, name, path on hover, action badge (Read, Created, Changed), diff preview | A file mentioned or touched | Folders (use a path row) |
| Task card | Title, status chip, project, current step, elapsed time, one primary action | Dashboard, background and project lists | Dense history (use the table) |
| Timeline | Vertical, connected nodes, each node a status icon plus a sentence; planned steps drawn as outlines; failed step auto-expands | One run's steps in order | Cross-run history (use the table) |

## Agent UI: from your goal to a checkable result

The hard problem is showing autonomous work without making the screen feel complicated. The answer is **three layers of detail and one rule**: the sentence (a status or a receipt), the steps (a timeline), and the payload (raw arguments and output). A person must never need the third layer to answer a yes or no question.

&#91;embedded content: from goal to result · 6 stages, one ledger\]

The picture reads left to right, then down. You ask, Rocky plans and starts a worker, the worker calls tools, tools produce actions, and actions end as receipts. The Actions box is the only highlighted one because it is where trust is decided: anything that changes the world outside Rocky passes through an approval card the client draws itself. Every stage writes an event to the ledger, so any box can be opened to its payload.

### Where state shows

State appears in four places and they must always agree, because they all render from one status value: the **pebble** (sidebar and message avatar), the **status chip** (run header and run card), the **timeline node icon**, and the **notification**. Colour decorates; the icon and word carry the meaning.

### The eleven states

| State | Pebble | Chip and wording | In the run | Controls |
| --- | --- | --- | --- | --- |
| **Rocky is thinking** | Breathes slowly (2.4s) in the agent colour | Info chip: "Thinking" | Run card shows "Planning" with three skeleton steps; after 8s adds elapsed time and "Taking longer than usual" | Stop |
| **Rocky is working** | Breathing, with the current worker's chip beside it | Info chip: "Working · step 3 of 7" (or elapsed time when steps are unknown) | One live verb line updates in place ("Reading 12 notes in \~/notes"); finished steps collapse to receipts | Pause, Stop, Add instruction |
| **Rocky is browsing** | Breathing; a small globe icon on the chip | Info chip: "Browsing example.com" | Run card shows a snapshot that refreshes every few seconds; the work pane does not open by itself; the take-over bar says who is in control | Take over, Pause, Open viewer |
| **Rocky is using a tool** | Breathing | Chip keeps "Working"; the step shows the tool | A tool-call block appears with tool, target, a permission badge (read or write) and a live duration; it becomes a receipt when done | Expand payload |
| **Rocky needs approval** | Stops breathing; a blush outline ring | Warning chip: "Needs you" with a hand icon | A blush-tinted approval card appears inline, in the Approvals queue and as a notification; the run is visibly paused, never spinning | Approve, Edit, Deny, Stop task |
| **Rocky completed the task** | Returns to rest with a small check mark | Success chip: "Done" | The run collapses to one line: "Done in 4 min · 12 read · 1 file created · 0 sent" with Open results; a notification only if the user was away | Open results, Undo (where reversible), Re-run |
| **Rocky failed** | Static, with an error mark in the corner | Error chip: "Failed" with an octagon icon | The failed step opens automatically: what happened, what Rocky tried, what you can do; completed steps and their receipts stay in view so progress is not lost | Retry this step, Retry from here, Ask Rocky to fix it, Stop |
| **Rocky is waiting** | Rests, slightly dimmed | Neutral chip: "Waiting" with a clock icon | States what and until when: "Waiting for a reply from Dana · checks again at 14:00" | Check now, Stop waiting |
| **Rocky is running in the background** | No animation in the foreground; a calm dot in the sidebar count ("2 running") | Neutral chip: "Background" | Lives in Tasks > Background; quiet one-line receipts; notifies only for needs-you, done and failed, as the user set | Pause, Open |
| **Rocky learned something** | A bookmark mark appears briefly on the pebble | Chip: "Learned" | A memory notice at the end of the run (batched, not one per fact): "Noted for next time: they only sign annual." with Edit and Forget; the item also lands in Memory under Learned this week | Edit, Forget, Accept |
| **Rocky remembers something** | None | A quiet chip under the message: "Used memory: Dana's preferences" with a book icon | Hover shows the exact line used; click opens the memory file; "Not right? Edit" is one click away | Open, Edit |

### Rules for all eleven

- **Nothing important happens silently.** If Rocky learns, spends, sends, deletes or gets blocked, there is a visible event.
- **Waiting for you looks different from waiting for the world.** The first is blush and urgent; the second is neutral and calm.
- **Failure never erases progress.** Completed receipts stay; only the failed step is highlighted.
- **One live line.** The working state shows one updating sentence, not a scrolling stream; the stream lives in the ledger.
- **Planned is not done.** Steps and actions that have not happened yet are drawn as outlines, so the audit trail can show intent without claiming completion (the one Muse idea worth taking whole).
- **Reduced motion.** The breathing pebble becomes a static ring with the same chip and word.

## Zero-budget, open-source frontend stack

Everything below is free and open source, runs locally and needs no paid service. I have not re-verified current versions or licences today; check each licence when you adopt it. The brief says the landing page is Vite plus vanilla TypeScript and does not describe the app's framework, so **first check what the local web UI is built with**. If it is not React, either keep it and use the framework-neutral parts of this list (tokens, Lucide, cmdk's alternatives, Shiki, CodeMirror, TanStack Virtual), or move the app to React once, early, because the accessible-primitive ecosystem is deepest there.

### Recommended picks

| Need | Pick | Why this one | Custom build? |
| --- | --- | --- | --- |
| App framework | React + TypeScript + Vite | Largest set of accessible primitives; same build tool as the landing page | No |
| UI components | Radix Primitives, with the shadcn/ui approach (copy components into your repo and restyle with Rocky tokens) | Accessible dialogs, menus, tabs, tooltips and selects without a runtime dependency on a design system. React Aria Components is the alternative where you want stronger keyboard behaviour (tables, combobox). | Style only |
| Icons | Lucide | Consistent outline set at 1.5px stroke, tree-shakable | Rocky's pebble and a handful of tool icons |
| Animation | CSS transitions first; Motion (the library formerly called Framer Motion) only for presence and layout animation | Keeps the bundle small and honours reduced motion | The breathing pebble (CSS keyframes) |
| Charts | uPlot for time series; hand-drawn SVG for the five-dot health strip and the step meter | Tiny and fast; Rocky has few charts | Health strip, cost meter |
| Rich text / editors | CodeMirror 6 with Markdown mode for memory and rules; a plain auto-growing textarea for the composer | Memory stays plain Markdown files, with no document model to convert | Composer mentions (small popover) |
| Markdown rendering | react-markdown with remark-gfm and rehype-sanitize | Safe by default for model output | Block-level memoisation for streaming |
| Code blocks | Shiki, loaded lazily | Accurate highlighting, themeable with Rocky colours | Copy button, line wrapping toggle |
| Command palette | cmdk | Purpose-built, accessible, unstyled | Command registry |
| Drag and drop | dnd-kit; native file drop for attachments | Keyboard-accessible reordering | None |
| Forms | React Hook Form with Zod | Validation shared between UI and engine | Rule and boundary editors |
| Toasts | Sonner | Small, accessible, styleable | Undo wiring |
| Virtual lists and tables | TanStack Virtual and TanStack Table (headless) | The ledger and history can be long; headless means Rocky's own markup | Row components |
| State | Plain TypeScript: a reducer over a typed event union for runs, Zustand for UI state | The run state machine is a handful of states; reach for XState only if it grows | The event types and reducer |
| Live updates | Server-sent events or a WebSocket from the local engine | Free on localhost; replay missed events by sequence number | Event schema |
| Diffs | jsdiff for computing, custom rendering | Memory and file diffs are small | Diff view |
| Design tokens | CSS custom properties generated from one tokens.json (Style Dictionary is optional) | One source for app and landing page; light and dark through `data-theme` | The token file |
| Fonts | Instrument Serif, Inter, JetBrains Mono, self-hosted (Fontsource packages) | All open licence; self-hosting avoids third-party requests, which suits a local-first tool | Subsetting |
| Accessibility | Radix or React Aria for behaviour; eslint-plugin-jsx-a11y; axe-core in Playwright tests; manual keyboard and screen-reader passes | Catches regressions automatically; tools cannot replace the manual pass | Focus rules for sheets and the work pane |
| Component docs and tests | Storybook (or Ladle for something lighter), Playwright for end-to-end and screenshot tests, Vitest for units | All free; GitHub Actions is free for public repositories | Stories for every state in the eleven-state table |
| Mobile | The same responsive web app as a PWA (vite-plugin-pwa), reached over the home network or Tailscale's free personal tier | No separate native app to maintain | Pairing flow |
| Phone notifications | ntfy (open source, self-hostable or the free public server) | Push without building a backend; notifications carry a link, never an Approve action | Topic setup in Settings |
| Browser view | Stream frames from the automation browser's screencast over the same WebSocket (feasible if Rocky drives Chromium through Playwright or the DevTools protocol; confirm against the engine) | No VNC or paid remote-desktop service | The viewer and take-over bar |
| Docs and landing | Landing stays Vite and vanilla; docs in Starlight or VitePress; host on GitHub Pages or Cloudflare Pages free tier | Free, static, fast | Content |
| Design work | Design in the browser with Storybook; Penpot (open source) or Figma's free tier for any visual exploration | Avoids a design handoff the solo developer does not need | Tokens first |

### What to build yourself (this is the product)

No library gives Rocky these, and they are the reason someone would choose Rocky: the **pebble** (SVG plus CSS), the **receipt line**, the **approval card and its trusted renderer**, the **run card and timeline**, the **take-over bar**, the **memory notice and memory diff**, the **status chip system**, and the **ledger row**. Keep them in one `agent-ui` folder with Storybook stories for every state, and reuse them on the landing page demo.

### Budgets and rules

- **Performance budget:** app shell under 200 KB of JavaScript gzipped on first load; Shiki, CodeMirror and uPlot loaded only when a screen needs them; fonts subsetted to Latin with `font-display: swap`; a send shows the user's bubble in under 100ms because the local engine is on the same machine.
- **No third-party calls from the UI by default:** no analytics, no hosted fonts, no CDN scripts. That is both a privacy promise and a trust signal.
- **One component per concept:** no second button, no second card. Anything new is a variant of an existing component or it needs a reason.
- **Order of work for one developer:** tokens and the shell; chat with the run card and receipt line; the approval card and queue; the ledger; memory; settings and rules; the browser view; mobile; then polish and the landing demo built from the same components.

## Final design verdict

### A. Best UI by category: which product is the design reference

This groups the 34 rows of the matrix in [Report 3](https://claude.ai/code/artifact/d9e5334a-7f62-43aa-88ac-ef44418bf184). G is Grok Bot, M is Muse, D is Dots. Rows marked \* rest mostly on vendor statements, not on UI I could see.

| Category | Reference | Principle Rocky takes | What Rocky leaves behind |
| --- | --- | --- | --- |
| Overall UI and app shell | G | Agents as colleagues in a clean work shell | The black pill-button house style |
| Navigation and information architecture | G | One obvious primary list, unread signals | A roster that grows without limit |
| Chat interface | G | Chat that ends in structured receipts | Chat as the only view of work |
| Agent and task layout | D | Chat beside the agent's workspace | One thread for everything |
| Activity and tool-use visualisation | G | Tool, verb, count, and what did not happen | Summaries that cannot be opened |
| Background-task UX | G | The list doubles as a morning briefing | Always-on as a selling point with no controls |
| Approval UX\* | M | Client-drawn approval the agent cannot reword | Approval described in prose only |
| Memory UX\* | M | Memory as files you can read and edit | A hidden profile |
| Settings and rules\* | D | Allow, ask, block, always-with-you as policy | Settings buried in a host app |
| Personalisation | M | A name, a face and one tone control | A character system |
| Onboarding and simplicity | D | Name your agent; one primary agent | Plan or platform gates |
| Notifications\* | D | Meet the user where they already are | Anything that approves from a notification |
| Error handling\* | G (weakly) | A blocked step hands control to the human | Showing only success stories |
| Loading, motion, micro-interactions | G | A labelled cursor, a timer, one live line | Blur effects that repeat |
| Accessibility and keyboard | D (page level only) | Skip links, reading-size type, reduced motion | 12px text, unlabelled images |
| Design system and consistency | G (tokens), D (consistency) | Two-tier tokens with light and dark; one scale and shape | Tokens that live only in compiled CSS |
| Mobile\* | M | Check in, approve, nudge | Driving a browser from a phone |
| Trust and transparency\* | M | Audit trail with plans, readable memory | Trust as copy on a landing page |
| Aesthetics | D | A single motif and colour system | Celebrity lifestyle styling |

### B. Rocky's ideal design

Rocky should be **the calm, warm, evidence-first agent app**. One assistant with a name and a pebble face; its helpers appear as chips on the run, never as separate chats. The home screen is "Today", and its first section is always "Needs you". Every action ends in a **receipt line** and is recorded in a **ledger** the user can open and export. Approvals are drawn by Rocky's own client from structured data, with a readable summary, a preview of the change, a risk label and the raw payload demoted to a collapsed block. Memory is a set of Markdown files with provenance, and every change Rocky proposes arrives as a diff. Boundaries (what Rocky may touch) are visible on every project and editable in one matrix. The look keeps the website's periwinkle, blush, rose and cocoa, with warm meaning you and cool meaning Rocky, and it uses flat, high-contrast controls with the soft material kept for the pebble and empty states. It works on a laptop first, with a phone view for approving and checking in, over the user's own network. It is built from free open-source parts and from a small set of custom agent components that are the actual product.

### C. Top 20 UI features to implement

| # | Feature | Priority | Why and where it comes from |
| --- | --- | --- | --- |
| 1 | Two-tier design tokens with light and dark themes | Critical | Everything else depends on it; Grok's token structure, with Rocky's palette |
| 2 | Approval card drawn from structured data (sentence, change preview, risk, why, collapsed payload) | Critical | Replaces the raw JSON queue; Muse's trust model |
| 3 | Receipt line on every completed action | Critical | Grok's best pattern, extended with permission and undo |
| 4 | One status system: pebble, chip, timeline icon and notification from a single value | Critical | Dots' identity idea fixed so identity never collides with state |
| 5 | The ledger: ordered, filterable, exportable activity view | Critical | Rocky has none today; Muse's audit trail including plans |
| 6 | Boundaries visible per project, with a permission matrix | Critical | Dots' tiers and Custom Rules; Grok does not show them |
| 7 | Today dashboard with "Needs you" first | Critical | Grok's roster-as-briefing, built around decisions |
| 8 | Memory screen with files, provenance and diff-based changes | High | Muse's readable memory, plus Grok's in-flow notice |
| 9 | Designed failure state with retry from here | High | No competitor shows failure; Rocky's open lane |
| 10 | Run page with a step timeline and planned steps drawn as outlines | High | Dots' layout; Muse's intent-before-action |
| 11 | Take-over bar and sign-in handoff banner | High | Grok's handoff and labelled cursor |
| 12 | Composer with Stop, queueing, @file and @worker mentions | High | Basic, but a stuck Stop button erodes trust fast |
| 13 | Onboarding that names Rocky and sets permission presets | High | Dots' ritual with Muse's caution |
| 14 | Command palette that reaches every screen and setting | Medium | Power-user speed at near-zero cost (cmdk) |
| 15 | Browser view with frames, control banner and take-over | Medium | Dots and Grok both lead with it; it needs the engine's screencast |
| 16 | Background routines with a health strip and auto-pause | Medium | Grok's morning briefing plus a safety stop |
| 17 | Files screen with diffs and revert | Medium | Makes local file changes undoable |
| 18 | Notifications that only ever say "Review" | Medium | A glance should never approve an action |
| 19 | Mobile PWA for approvals, status and short instructions | Medium | The one place a competitor beats a laptop-only tool |
| 20 | Rocky's identity swatch and one tone control | Low | Real delight but cheap to defer; Dots and Muse do it |

### D. Top ten design mistakes Rocky must avoid

1. **Copying Grok's black, pill-button, grey-text look.** It makes Rocky one of five identical dark tools. Stay warm and light-first.
2. **Letting the model write its own approval prompt.** The agent can reword a request into something harmless-sounding. Draw approvals from structured data.
3. **Keeping raw JSON as the approval UI.** It is evidence, not an interface. Summarise first, show the payload on demand.
4. **Using soft neumorphic surfaces for controls.** Edges at about 1.2:1 contrast are invisible to many users. Flat fills with a 3:1 border.
5. **Using pastel red as text, a thin icon or the only sign of an error.** It measures 2.36:1 on the canvas. Fill plus ink, and always an icon and a word.
6. **Spinners and "thinking…" theatre.** Show one live verb line, a count and the elapsed time instead.
7. **Designing only the success path.** Every competitor does, which is why failure design is Rocky's easiest win.
8. **Silent learning.** Memory that changes without a visible notice and a diff destroys trust faster than any bug.
9. **An unbounded roster or one endless thread.** Use one face, many hands, and a "Needs you" inbox.
10. **Spending design time on avatars, voices and themes before approvals, ledger and failure states.** Personality is the last 10 percent.

### E. Rocky Design DNA

Eight principles for every future decision. Each has a test.

1. **Show the work in one line.** Every action ends in a receipt a person can check. *Test: could someone verify this without opening a log?*
2. **Ask on a surface the agent cannot write to.** *Test: could the model have changed how this request looks?*
3. **Warm is you, cool is Rocky.** Identity colour decorates; state is an icon and a word. *Test: does this screen still read in greyscale?*
4. **Files over profiles.** Memory, rules and logs are plain files the user owns. *Test: can the user open, edit and delete this?*
5. **Failure first.** Design what happens when it goes wrong before what happens when it goes right. *Test: where does a failed step appear, and what can the user do?*
6. **Calm by default.** No urgency, no streaks, no exclamation marks; motion only explains state. *Test: would this still make sense with animation off?*
7. **One face, many hands.** The user talks to Rocky; workers are chips. *Test: did we just add a second place to talk?*
8. **Boundaries are always visible.** What Rocky may touch is one glance away. *Test: from this screen, can I see what Rocky is allowed to do?*

### F. Final frontend blueprint

Build and review in this order. Each layer is done when the definition under it is true.

1. **Design system.** Tokens (primitive, semantic, component) with light and dark; type scale; spacing; radius; shadow; icon set; motion tokens. *Done when:* the landing page and a Storybook page both render from the same token file and pass the contrast values in this spec.
2. **Components.** The controls, containers and data components, then the custom agent set (pebble, status chip, receipt, run card, timeline, approval card, take-over bar, memory notice, ledger row). *Done when:* every component has stories for default, hover, focus, disabled, loading, empty and error, and a keyboard-only pass.
3. **Screens.** The app shell, then screens in this order: Today, chat and workspace, run page, approvals, ledger, memory, settings and rules, projects, tasks and background, files, integrations, notifications, profile, help; onboarding and the landing page last. *Done when:* each screen has all four states (loading, empty, error, populated) at three widths.
4. **User flows.** Six flows tested end to end: first run (install, name, boundaries, first task); ask and watch; approve; fail and retry; morning-after review; correct a memory. *Done when:* each can be completed by someone who has not seen Rocky, in under two minutes for the first run.
5. **Agent UX.** The eleven-state table implemented from one status value across pebble, chip, timeline and notification; the typed event stream; the three layers of detail. *Done when:* a recorded run shows every state and the four places agree.
6. **Responsive design.** Breakpoints, the sheet pattern for the work pane, the bottom tab bar and the mobile approval flow. *Done when:* nothing scrolls horizontally from 360px up and every primary action is 44px or larger.
7. **Accessibility.** Focus ring, skip link, landmarks, live regions for status changes, reduced motion, 3:1 control borders, screen-reader names for icon buttons, and a manual pass with a keyboard and a screen reader. *Done when:* axe finds no serious issues and the manual pass is written up in the repository.
8. **Motion.** The breathing pebble, 120 / 200 / 320ms transitions, the fade-in for streamed events, and reduced-motion substitutes. *Done when:* turning motion off loses no information.
