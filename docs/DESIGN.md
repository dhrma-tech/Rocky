# DESIGN.md: Rocky

Design system and UI specification for an open-source, local-first AI assistant (cross-app memory, cited answers, approval-gated actions, student notebook module). Covers the **marketing landing page** (`apps/landing`) and the **app interface** (`apps/web`). Written for Claude Code, Claude Design and any human contributor.

**Status:** v1 draft. Colors are final (user-supplied palette). Fonts, logo and install command are open (Section 0.2). Product name: Rocky.

---

## 0. READ FIRST

### 0.1 How this file was built

| Input | Used for | Reliability |
|---|---|---|
| Clico landing page teardown (tryclico.com, measured live 2026-10-03 at 1118 px; 768 and 390 via iframes) | Landing page structure, rhythm, copy patterns, material system, motion | Measured. Desktop numbers are at 1118 px, not 1440. No dark mode on the reference |
| Perplexity web app teardown (signed-out, dark theme, **Home screen only**, 882 px viewport) | App shell, sidebar, composer, token architecture | Measured for Home only. **Thread view, overlays, panels, responsive and motion were not observed** |
| User palette (5 colors) | **All color everywhere** | Final |

Rules this implies:

1. **No color from either reference is used.** Reference hex values appear only as "what the reference did". All color comes from the palette in Section 2.
2. Where the app references were silent (thread view, side panels, overlays, states, mobile), this file contains **design decisions by us**, marked **[DECISION]**. They follow common chat-app conventions and are unverified against a reference. Validate them with a signed-in reference teardown if you want a closer match to a specific product.
3. Values marked **[derived]** were computed from the palette (recipe given). Values marked **[measured]** come from the references and are kept only for layout and spacing.

### 0.2 Open decisions (fill before build)

| # | Decision | Where it plugs in |
|---|---|---|
| 1 | **Fonts**: 3 roles (Display, UI sans, Mono), chosen by the owner | `--font-display`, `--font-sans`, `--font-mono` (Section 3) |
| 2 | Logo (name decided: Rocky) | Header, footer, README |
| 3 | Install command and download targets | Hero, final CTA (`{{INSTALL_COMMAND}}`) |
| 4 | GitHub repo URL and star-count source | Announcement bar, header, trust strip |
| 5 | Hosted tier: yes or no (affects "Ways to run it") | Section 4.12 |
| 6 | Visual check of the dark theme (it is derived, not designed) | Section 2.4 |
| 7 | Reference for thread view and side panels (optional follow-up teardown) | Section 5.5 |

### 0.3 Design principles

1. **Quiet and tactile.** One soft canvas, raised surfaces, almost no borders. Color is rare and meaningful.
2. **Show the product, not claims.** The hero is a working-looking demo. The pinned section walks through ask, cite, approve.
3. **Trust is visible.** Citations, approval cards, the local-only badge and the audit log are first-class UI, not footnotes.
4. **Open-source honesty.** Proof is the license, the repo, what stays on the device. No invented logos or testimonials.
5. **Accessible by default.** Fix what the references got wrong: AA contrast for all text, 44 px touch targets, labeled controls, one focus style.
6. **Light by default, dark supported.** Light theme is the brand face. Dark theme is derived from the cocoa color.

---

## 1. BRAND AND VOICE

- **Feel:** soft, warm, calm, precise, editorial. Cool periwinkle canvas with warm rose accents.
- **Voice:** plain, second person, confident, no exclamation marks, no superlatives. Short declaratives that end in a period (pattern from the reference: category claim; input-to-output; parallel imperatives).
- **Headline length:** 4 to 8 words.
- **CTA wording:** verb + object (+ arrow on secondary links). Examples: "Download", "Star on GitHub", "Read the docs →".
- **Do not claim** anything not true of the shipped product (offline support, encryption, specific model support) without verifying.

---

## 2. COLOR

### 2.1 Palette (final, user-supplied)

| Token | Name | HEX | RGB | Role summary |
|---|---|---|---|---|
| `--pal-periwinkle` | Light Periwinkle | `#D0D9E6` | 208, 217, 230 | Canvas family, sunken wells, sidebar |
| `--pal-blush` | Light Blush Pink | `#F2D3D3` | 242, 211, 211 | Soft accent surface, selection, highlights |
| `--pal-rose` | Dusty Rose | `#EDB0B1` | 237, 176, 177 | Secondary accent, chips, borders on warm surfaces |
| `--pal-red` | Pastel Red | `#E67E7F` | 230, 126, 127 | **Primary action color** (fills only) |
| `--pal-cocoa` | Cocoa Brown | `#915E56` | 145, 94, 86 | Strong accent: links, focus ring, icons, dark theme base |

Note: the source swatch image prints Dusty Rose RGB as "37, 176, 177", which is a typo. `#EDB0B1` = 237, 176, 177. The hex is authoritative.

### 2.2 Derived neutrals [derived]

The palette has no near-black, so one is derived from Cocoa. All recipes are linear RGB mixes.

| Token | HEX | Recipe | Use |
|---|---|---|---|
| `--ink` | `#2E1E1C` | Cocoa mixed 68% toward black | Primary text, text on Pastel Red |
| `--ink-2` | `#50342F` | Cocoa mixed 45% toward black | Secondary text |
| `--ink-3` | `#6D4640` | Cocoa mixed 25% toward black | Tertiary text, text on Blush |
| `--canvas` | `#EAEEF4` | Periwinkle mixed 55% toward white | Page background |
| `--canvas-soft` | `#F1F4F8` | Periwinkle mixed 70% toward white | Large quiet panels |
| `--raised` | `#F8F9FB` | Periwinkle mixed 85% toward white | Cards, composer, popovers |
| `--sidebar` | `#DDE4ED` | 50% Periwinkle + 50% Canvas | App sidebar |
| `--blush-tint` | `#F8E9E9` | Blush mixed 50% toward white | Hover on warm surfaces, banners |
| `--occlusion` | `#9CA3AC` | Periwinkle mixed 25% toward black | Shadow color (bottom-right) |
| `--border-base` | `#D3D5DA` | Canvas mixed 12% toward ink | Hairlines |
| `--border-strong` | `#C1C0C4` | Canvas mixed 22% toward ink | Inputs, emphasized dividers |

### 2.3 Light theme semantic tokens (default)

| Semantic token | Value | Notes |
|---|---|---|
| `--bg-page` | `--canvas` | Landing and app |
| `--bg-sunken` | `--pal-periwinkle` | Wells, code blocks, inactive tracks |
| `--bg-sidebar` | `--sidebar` | App sidebar |
| `--bg-raised` | `--raised` | Cards, composer, menus |
| `--bg-overlay` | `--raised` | Modals, popovers (+ scrim, below) |
| `--scrim` | `rgba(46,30,28,.38)` | Behind modals |
| `--text-primary` | `--ink` | 13.7:1 on canvas |
| `--text-secondary` | `--ink-2` | 9.6:1 on canvas |
| `--text-tertiary` | `--ink-3` | 6.9:1 on canvas. **Lightest allowed text color** |
| `--text-on-accent` | `--ink` | Text on Pastel Red (5.8:1) |
| `--text-on-dark` | `--blush-tint` | On cocoa-dark sections |
| `--link` | `--pal-cocoa` | 4.6:1 on canvas, 5.1:1 on raised |
| `--link-hover` | `#82544D` | Cocoa mixed 15% toward ink |
| `--accent` | `--pal-red` | Fills only, never text |
| `--accent-hover` | `#E98D8E` | Red mixed 12% toward white |
| `--accent-pressed` | `#D07273` | Red mixed 12% toward ink |
| `--accent-soft` | `--pal-blush` | Selected rows, active chips, highlights |
| `--accent-soft-hover` | `--blush-tint` | |
| `--accent-2` | `--pal-rose` | Secondary fills, progress, illustration |
| `--accent-strong` | `--pal-cocoa` | Icons, active indicators, focus ring |
| `--focus-ring` | `--pal-cocoa` | 2 px ring + 2 px canvas offset (4.6:1, passes 3:1 UI rule) |
| `--layer-faint` | `rgba(46,30,28,.03)` | Ink at 3%: resting tint |
| `--layer-subtle` | `rgba(46,30,28,.06)` | Ink at 6%: hover |
| `--layer-strong` | `rgba(46,30,28,.10)` | Pressed |
| `--success` | `#2F6B49` | 5.4:1 on canvas |
| `--warning` | `#86580F` | 5.3:1 on canvas |
| `--danger` | `#B23A48` | 5.0:1 on canvas |
| `--info` | `#3F6299` | 5.3:1 on canvas |

Status colors are outside the five-color palette by necessity (the palette has no green, amber or blue). They are muted so they sit with the warm and cool pastels. Never rely on color alone: always pair with an icon and a word.

### 2.4 Dark theme semantic tokens [derived, validate visually]

Derived from Cocoa mixed toward black. Warm near-blacks, no pure black.

| Semantic token | Value | Recipe or contrast |
|---|---|---|
| `--bg-underlay` | `#130C0B` | Cocoa 87% toward black |
| `--bg-page` | `#1A110F` | Cocoa 82% toward black |
| `--bg-sidebar` | `#150E0C` | Between underlay and page |
| `--bg-raised` | `#261816` | Cocoa 74% toward black |
| `--bg-overlay` | `#31201D` | Cocoa 66% toward black |
| `--scrim` | `rgba(0,0,0,.55)` | |
| `--text-primary` | `#F9EBEB` | Blush mixed 55% toward white. 16.0:1 on page |
| `--text-secondary` | `#9DA1AA` | Periwinkle at 72% over page. 7.2:1 |
| `--text-tertiary` | `#7E7F85` | Periwinkle at 55% over page. 4.65:1 on page, **4.3:1 on raised, use on page bg only** |
| `--text-on-accent` | `#2E1E1C` | On Pastel Red |
| `--link` | `--pal-rose` | 10.1:1 |
| `--accent` | `--pal-red` | 6.8:1 on page, usable as text/icon in dark |
| `--accent-soft` | `rgba(230,126,127,.16)` | Selected rows |
| `--accent-strong` | `--pal-rose` | Icons, focus ring |
| `--focus-ring` | `--pal-rose` | 2 px ring + 2 px page offset |
| `--border-base` | `rgba(249,235,235,.12)` | |
| `--border-strong` | `rgba(249,235,235,.22)` | |
| `--layer-faint/subtle/strong` | blush-tint at 3% / 6% / 10% | |
| `--success` | `#7FC79A` | 9.3:1 |
| `--warning` | `#E0B060` | 9.3:1 |
| `--danger` | `#F08A94` | 7.8:1 |
| `--info` | `#8FB2E6` | 8.6:1 |

### 2.5 Contrast reference (computed, WCAG 2.x)

| Pair | Ratio | Allowed use |
|---|---|---|
| Ink on Canvas | 13.7 | All text |
| Ink-2 on Canvas | 9.6 | All text |
| Ink-3 on Canvas | 6.9 | All text |
| Ink on Raised | 15.1 | All text |
| Ink on Pastel Red | 5.8 | **Button text on primary CTA** |
| Ink on Dusty Rose | 8.7 | Text on rose chips |
| Ink on Blush | 11.4 | Text on selected rows |
| Ink on Periwinkle | 11.2 | Text on sunken wells |
| Ink-2 on Blush | 8.0 | Secondary text on selected rows |
| Ink-3 on Blush | 5.8 | Lowest text on warm surfaces |
| Cocoa on Canvas | 4.6 | Links, icons, focus ring |
| Cocoa on Raised | 5.1 | Links |
| White on Cocoa | 5.3 | Text on cocoa buttons |
| **Cocoa on Blush** | **3.8** | **Not for text.** Use Ink-3 |
| **White on Pastel Red** | **2.7** | **Forbidden** |
| **Pastel Red on Canvas** | **2.4** | **Never text or sole-meaning icon** |
| **Dusty Rose on Canvas** | **1.6** | **Decoration only** |

### 2.6 Color rules

1. Text is always `--ink`, `--ink-2`, `--ink-3` (light) or their dark equivalents. Never Pastel Red, Dusty Rose or Blush as text color on light backgrounds.
2. Pastel Red is a **fill** color: primary button, active toggle, badges with dark text, progress. Its label is always Ink.
3. One primary action per view uses Pastel Red. Everything else is secondary (raised) or ghost.
4. Cocoa carries structure: links, active nav indicator, icons, focus rings, and the dark sections of the landing page.
5. No gradient text built from palette colors (Rose and Red fail contrast on light). The hero may use a **one-time highlight sweep** across the H1 that ends in solid Ink.
6. Gradients are allowed on surfaces: Periwinkle to Blush (soft panels), Blush to Rose (feature cards), Cocoa dark to page dark (dark sections).
7. Status colors are for status only.

---

## 3. TOKENS

### 3.1 Typography (fonts pending, owner chooses)

Three font roles. Pick any family that meets the constraints; the scale below works with them.

| Role | CSS var | Used for | Constraints for the choice |
|---|---|---|---|
| Display | `--font-display` | Landing H1-H3, notebook titles | Real webfont, loaded with `font-display: swap`. Must have weight 400 and good negative tracking at 40 px+. **Do not rely on a system serif fallback** (the reference's headings changed per OS) |
| UI sans | `--font-sans` | Body, UI, buttons, app | Variable font preferred (supports fractional weights). Tabular numbers available for the budget meter and timestamps |
| Mono | `--font-mono` | Nav labels (landing), payload blocks, code, shortcuts, IDs | Distinct zero; legible at 12 px |

Always declare a full fallback stack and size-adjust to limit layout shift.

**Landing scale** (measured from the reference, kept for rhythm; sizes fluid via `clamp`)

| Role | Font | Size at 1280 / 768 / 390 | Weight | Line-height | Tracking | Color |
|---|---|---|---|---|---|---|
| H1 | Display | 48 / 42 / 39 | 400 | 1.06 | -0.055em | ink |
| H2 | Display | 42 / 34 / 32 | 400 | 1.05 to 1.1 | -0.05em | ink (on dark: blush-tint) |
| H3 plan or card (large) | Display | 30 | 400 | 1.1 | -0.035em | ink |
| H3 card | Display | 24 | 400 | 1.14 | -0.035em | ink |
| H3 small | Display | 18 | 400 | 1.35 | 0 | ink |
| FAQ question | Sans | 20 | 600 | 1.3 | -0.025em | ink |
| Body large | Sans | 17 | 400 | 1.6 | 0 | ink-2 |
| Body | Sans | 16 | 400 | 1.55 to 1.65 | 0 | ink-2 |
| Descriptor / small | Sans | 14 | 400 | 1.65 | 0 | ink-2 |
| Button | Sans | 14 | 600 | 1 | -0.01em | ink |
| Nav and labels | **Mono** | **12** (reference used 10, too small) | 500 | 1.2 | +0.02em, uppercase | ink-2 |

**App scale** [measured from the app reference, kept]

| Role | Size / weight / line-height |
|---|---|
| Page heading | 24 / 350 / 32 |
| Body, input | 16 / 350 / 24 |
| UI label | 14 / 350 / 20 (medium 440) |
| Small, chip | 12 / 440 / 16 |
| Micro (badge) | 11 / 440 / 12 |

Fractional weights (350, 440) assume a variable UI font. If the chosen font is not variable, map 350 to 400 and 440 to 500.

Answer text in the thread view uses `--font-answer` (default = `--font-sans`; user setting can switch to `--font-display` or a serif). [DECISION]

### 3.2 Spacing (4 px base) [measured, app]

`2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48`, then landing section steps `64, 72, 80, 88, 120, 160, 180, 220`. Components snap to 4. Landing sections snap to 8.

### 3.3 Radii

| Token | Value | Use |
|---|---|---|
| `--r-xs` | 4 | Tags, small controls |
| `--r-sm` | 8 | Section header rows, tooltips |
| `--r-md` | 12 | Nav rows, buttons, icon buttons |
| `--r-lg` | 16 | Composer, app cards |
| `--r-xl` | 24 | Landing cards, demo composer |
| `--r-2xl` | 28 | Bento cards, panels |
| `--r-3xl` | 34 | Footer panel |
| `--r-4xl` | 48 | Dark section edge |
| `--r-full` | 9999 | Pills, chips, round buttons |

### 3.4 Elevation: soft raised system

One material across landing and app: surfaces rise from the canvas with a **white key light (top-left)** and a **periwinkle-dark occlusion (bottom-right)**. Borders are nearly absent: edges are a 0.8 px white inner border at 70% plus shadows.

Light theme (occlusion = `rgba(156,163,172,α)`):

| Token | Value |
|---|---|
| `--shadow-raised-sm` | `-4px -4px 10px rgba(255,255,255,.95), 5px 6px 14px rgba(156,163,172,.43)` |
| `--shadow-raised-md` | `-8px -8px 20px rgba(255,255,255,.95), 10px 12px 26px rgba(156,163,172,.47)` |
| `--shadow-raised-lg` | `-11px -11px 28px rgba(255,255,255,.95), 14px 17px 38px rgba(156,163,172,.52)` |
| `--shadow-inset-sm` | `inset 3px 3px 7px rgba(156,163,172,.45), inset -3px -3px 7px rgba(255,255,255,.9)` (pressed, wells) |
| `--shadow-float` | `0 14px 32px rgba(120,128,140,.16), inset 0 1px 0 rgba(255,255,255,.9)` (header pill, popovers) |
| `--edge` | `inset 0 0 0 .8px rgba(255,255,255,.7)` |

Dark theme: no white key light. Use `0 1px 0 rgba(249,235,235,.05) inset, 0 8px 24px rgba(0,0,0,.4)` for raised; `0 16px 48px rgba(0,0,0,.55)` for overlays.

**Performance note:** heavy dual shadows on many elements cost paint time. Apply raised-lg only to large cards and use raised-sm on repeated rows.

### 3.5 Motion

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | Reveals, panels, sheets |
| `--ease-ui` | `cubic-bezier(.25,.1,.25,1)` | Hover, color, small movements |
| `--dur-fast` | 180ms | Hover color and background |
| `--dur-base` | 240ms | Lift, shadow, small transforms |
| `--dur-panel` | 320ms | Sidebar collapse, drawer open, chip expand |
| `--dur-reveal` | 550 to 750ms | Scroll reveals |
| `--dur-flip` | 280ms | Flashcard flip |

Rules: hover lifts are 1 to 2 px. Sidebar collapse is **animated** (the reference was instant, which felt abrupt). The rotating-placeholder flicker of the reference is not used. Honor `prefers-reduced-motion`: disable parallax, pinned-scroll transforms, sweeps and flips (replace with fades under 120 ms), and stop looping video.

### 3.6 Layout constants

| Token | Value |
|---|---|
| Landing container | viewport minus 48 px (24 px side margins), max 1200 |
| Landing text max-widths | 560, 640, 680, 760, 940 |
| Sidebar width / collapsed | 240 / 56 [measured] |
| Nav row | 224 x 40, gap 1 [measured] |
| Section header row | 224 x 32 |
| Icon button | 32 visual, **44 x 44 hit area** [DECISION, fixes reference] |
| Composer (Home) | width 77% of main, min 360, max 720; min height 118 |
| Composer (thread) | docked bottom, width = content column, max 760 |
| Thread content column | max 720 |
| Right drawer (source viewer) | default 420, resizable 360 to 640 |
| Header (landing) | pill, 56 high, ~640 wide, ~48 from top |

### 3.7 Breakpoints (fewer than the reference's 16)

`1280`, `1024`, `768`, `480`. Anything else is a container query inside a component.

### 3.8 Z-index

`base 0`, `sticky 10`, `sidebar 20`, `drawer 30`, `header-pill 40`, `popover 50`, `modal 60`, `toast 70`, `recording-pill 80`.

### 3.9 CSS variables (starter)

```css
:root {
  /* palette */
  --pal-periwinkle:#D0D9E6; --pal-blush:#F2D3D3; --pal-rose:#EDB0B1;
  --pal-red:#E67E7F; --pal-cocoa:#915E56;
  /* derived */
  --ink:#2E1E1C; --ink-2:#50342F; --ink-3:#6D4640;
  --canvas:#EAEEF4; --canvas-soft:#F1F4F8; --raised:#F8F9FB; --sidebar:#DDE4ED;
  --blush-tint:#F8E9E9; --occlusion:#9CA3AC;
  /* semantic (light) */
  --bg-page:var(--canvas); --bg-sunken:var(--pal-periwinkle); --bg-sidebar:var(--sidebar);
  --bg-raised:var(--raised); --bg-overlay:var(--raised); --scrim:rgba(46,30,28,.38);
  --text-primary:var(--ink); --text-secondary:var(--ink-2); --text-tertiary:var(--ink-3);
  --text-on-accent:var(--ink); --text-on-dark:var(--blush-tint);
  --link:var(--pal-cocoa); --link-hover:#82544D;
  --accent:var(--pal-red); --accent-hover:#E98D8E; --accent-pressed:#D07273;
  --accent-soft:var(--pal-blush); --accent-soft-hover:var(--blush-tint);
  --accent-2:var(--pal-rose); --accent-strong:var(--pal-cocoa);
  --focus-ring:var(--pal-cocoa);
  --border-base:#D3D5DA; --border-strong:#C1C0C4;
  --layer-faint:rgba(46,30,28,.03); --layer-subtle:rgba(46,30,28,.06); --layer-strong:rgba(46,30,28,.10);
  --success:#2F6B49; --warning:#86580F; --danger:#B23A48; --info:#3F6299;
  /* shadows */
  --shadow-raised-sm:-4px -4px 10px rgba(255,255,255,.95),5px 6px 14px rgba(156,163,172,.43);
  --shadow-raised-md:-8px -8px 20px rgba(255,255,255,.95),10px 12px 26px rgba(156,163,172,.47);
  --shadow-raised-lg:-11px -11px 28px rgba(255,255,255,.95),14px 17px 38px rgba(156,163,172,.52);
  --shadow-inset-sm:inset 3px 3px 7px rgba(156,163,172,.45),inset -3px -3px 7px rgba(255,255,255,.9);
  --shadow-float:0 14px 32px rgba(120,128,140,.16),inset 0 1px 0 rgba(255,255,255,.9);
  /* motion */
  --ease-out:cubic-bezier(.22,1,.36,1); --ease-ui:cubic-bezier(.25,.1,.25,1);
  --dur-fast:180ms; --dur-base:240ms; --dur-panel:320ms; --dur-reveal:650ms; --dur-flip:280ms;
  /* fonts: owner to set */
  --font-display:{{FONT_DISPLAY}}, Georgia, serif;
  --font-sans:{{FONT_SANS}}, system-ui, sans-serif;
  --font-mono:{{FONT_MONO}}, ui-monospace, monospace;
}
:root[data-theme="dark"] {
  --bg-page:#1A110F; --bg-sidebar:#150E0C; --bg-raised:#261816; --bg-overlay:#31201D;
  --bg-sunken:#130C0B; --scrim:rgba(0,0,0,.55);
  --text-primary:#F9EBEB; --text-secondary:#9DA1AA; --text-tertiary:#7E7F85;
  --link:var(--pal-rose); --accent-soft:rgba(230,126,127,.16); --accent-strong:var(--pal-rose);
  --focus-ring:var(--pal-rose);
  --border-base:rgba(249,235,235,.12); --border-strong:rgba(249,235,235,.22);
  --layer-faint:rgba(249,235,235,.03); --layer-subtle:rgba(249,235,235,.06); --layer-strong:rgba(249,235,235,.10);
  --success:#7FC79A; --warning:#E0B060; --danger:#F08A94; --info:#8FB2E6;
  --shadow-raised-sm:0 1px 0 rgba(249,235,235,.05) inset,0 4px 14px rgba(0,0,0,.35);
  --shadow-raised-md:0 1px 0 rgba(249,235,235,.05) inset,0 8px 24px rgba(0,0,0,.4);
  --shadow-raised-lg:0 1px 0 rgba(249,235,235,.05) inset,0 16px 48px rgba(0,0,0,.55);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* mirror the dark block above */ }
}
```

---

## 4. LANDING PAGE

Modeled on the structure and rhythm of the reference landing page (a single long page with a floating pill header, a hero that is the product, a pinned input-to-output demo, one dark section, bento cards, FAQ, final CTA, large footer panel), adapted to an open-source local-first product. **Palette, fonts and copy are ours.**

### 4.1 Page-level rules

- **Length:** target about 10 screens (roughly 8,500 to 11,000 px at 1280). The reference was 17 screens; cut media weight, not substance.
- **Media budget:** under 2 MB for first load, under 6 MB total. Use AVIF or WebP for images, short WebM clips with `preload="none"` and poster images. The reference shipped about 10 MB.
- **Canvas:** one flat `--canvas` color for the page. Sections are separated by spacing (120 to 180 px), not lines. Rounded 48 px edges mark the one dark section.
- **Social proof:** the reference had none. We replace logos and testimonials with **verifiable open-source proof**: license, stars, latest release, contributor count, "what stays on your device".
- **No sign-in wall.** There is no account. Every CTA is Download, Star on GitHub, or Read the docs.
- **No backend call from the page.** Demos are scripted client-side animations and are labeled "Sample".
- **SEO and AI-discovery:** one page for comparison content only if wanted later. Do not copy the reference's link farm.

### 4.2 Section map

| # | Section | Height (1280) | Background | Reference equivalent |
|---|---|---|---|---|
| 0 | Announcement bar | 32 | page | Model badge bar |
| 1 | Header pill | 56, fixed | blur glass | Floating pill header |
| 2 | Hero | 860 to 960 | page | Hero + composer |
| 3 | Trust strip | 120 | page | (none, added) |
| 4 | Pinned demo: Ask, Cite, Approve | ~3.2 screens scroll (pin 726) | page + rounded soft panel | "Create from a photo, chat or PDF" |
| 5 | Connectors | 1,100 to 1,400 | **dark cocoa** | Dark image showcase |
| 6 | Local-first explainer | 900 | dark continues, then rounded bottom edge | Builder story |
| 7 | Audience bento | 1,300 | page | Studio bento |
| 8 | Student notebook | 900 | page | (none, added) |
| 9 | Privacy and control | 800 | page | (none, added) |
| 10 | Ways to run it | 760 | page | Pricing |
| 11 | FAQ | 1,200 | page | FAQ |
| 12 | Final CTA | 600 | page | Final composer |
| 13 | Footer | ~600 | raised panel | Footer panel |

### 4.3 Header (section 1) and announcement bar (section 0)

- **Announcement bar:** one line, 12 to 13 px, centered. Format: `[Release badge] vX.Y.Z is out. Read the changelog →`. Badge is a Blush pill with Ink text. Link in Cocoa, underline on hover. Dismissible, state in `localStorage`.
- **Header pill:** fixed, centered, 56 px high. Glass: background `rgba(234,238,244,.84)`, `backdrop-filter: blur(20px) saturate(1.2)`, radius 25, padding 6/8/6/6, `--shadow-float`. Starts about 48 px from the top (below the bar).
- **Items:** round logo button, Product ▾, Connectors, Students, Privacy, Docs, **GitHub ★ {{count}}** (ghost), **Download** (primary).
- **Nav link:** Mono 12 px uppercase, `--ink-2`, height 40, radius 999. Hover: color `--ink`, `translateY(-1px)`, `--shadow-raised-sm`. Transition `color/background .18s, box-shadow .24s, transform .24s` with `--ease-ui`.
- **Download:** `--accent` fill, Ink text 14/600, height 44, radius 12, `0.8px` white inner border, hover `--accent-hover` and `translate(2px,-2px)` over .22s, pressed `--accent-pressed`.
- **GitHub button:** ghost, height 44, star count in Mono.
- **Scroll:** always visible, no shrink. Overlays content.
- **Mobile (≤768):** nav hidden. 44 x 44 "Open menu" button. Pill width = viewport minus 48. Drawer: full-height sheet from the right, 320 ms `--ease-out`, items 56 px high, focus trapped, Esc closes. [DECISION: the reference drawer was not measured.]
- **Dropdown (Product ▾):** Overview, Meetings, Notebooks, Actions and approvals, Connectors. Popover radius 16, padding 8, rows 44 px.

### 4.4 Hero (section 2)

**Composition (top to bottom):** announcement bar, pill header, about 140 px blank, H1, "Ask your work" demo composer, scope chips, descriptor line, install snippet. Heavy whitespace (padding about 300 top / 260 bottom at desktop).

- **H1:** 4 to 8 words, Display, period at the end. Specifies what the product does, not a slogan. Final copy: `{{HERO_H1}}`. The highlight sweep (Section 2.6 rule 5) runs once on load across two words, 1.2 s, ends solid Ink.
- **Subhead / descriptor:** 25 to 32 words, Sans 14 to 16, `--ink-2`, max width 640, line-height 1.65. States: remembers meetings, messages, docs, apps; answers with sources; acts only when you approve; runs on local models or your own key.
- **Demo composer (600 x 224 at desktop, 358 x ~325 at 390):** radius 24, background `rgba(248,249,251,.9)`, `--edge`, `--shadow-raised-md`. Contains: round "+" attach (32, raised), scope chip ("Everything"), model chip with local badge, mic, and a **Download** primary pill instead of "Start creating". Typing is **simulated**: three **sample question chips** below ("What did we decide about pricing?", "Who owes me a reply?", "Quiz me on lecture 4") run a scripted answer with 2 to 3 citation chips and a visible "Sample" tag. No sign-in, no network.
- **Scope chips (6, 56 x 56 squares, radius 12):** Meetings, Messages, Docs, Tasks, Notebook, Code. The active one expands to about 224 wide with a label (`flex-basis .32s`). Background `rgba(255,255,255,.78)`, shadow `0 16px 32px rgba(120,128,140,.12)` + white inset. Icons 20 px, 1.5 px stroke, `--ink`.
- **Floating cards:** two small UI cards (a citation chip stack, an approval card) drift in on scroll and settle. Decorative, `aria-hidden`.
- **Install snippet:** a single mono line in a sunken well with a copy button: `{{INSTALL_COMMAND}}`. Copy gives a "Copied" toast (2 s).
- **CTAs:** Download (primary), Star on GitHub (secondary). Two only.
- **Mobile (390):** hero about 1,035 px, H1 39 px (10vw), composer 358 wide, chips scroll horizontally.

### 4.5 Trust strip (section 3)

One row, centered, Mono 12 uppercase labels with small line icons, separated by 24 px. Items (each links to proof): `Open source · {{LICENSE}}`, `Runs on your machine`, `No account needed`, `★ {{stars}}`, `Latest release {{version}}`, `{{n}} contributors`. Build-time data from the repo (no runtime third-party request). Wraps to two rows on mobile.

### 4.6 Pinned demo: Ask. Cite. Approve. (section 4)

- **Container:** rounded panel (radius 28 to 34) with a soft Periwinkle-to-Blush gradient on the page canvas. Section height about 4,300 px with an inner `position: sticky; top: 0` pin of about 726 px (about 3.6 screens of scroll).
- **Heading:** H2 (5 to 8 words) + subhead (15 to 20 words), centered.
- **Left column: simulated app.** A reference chip, the user's question bubble, the composer, and **4 tabs: Ask, Cite, Draft, Approve**. Scroll steps through the tabs; the active tab chip expands (`.32s`).
- **Right column: output** (crossfade, `--ease-out`), with a caption above or below (12 to 20 words):
  1. **Ask:** a question across meetings, mail and docs, answer streaming in.
  2. **Cite:** the same answer with numbered citation chips; one source opened at the exact page or timestamp, highlighted.
  3. **Draft:** an email reply drafted in the user's voice, saved as a draft.
  4. **Approve:** an **approval card** showing the exact payload for a new task, with Approve and Reject, and the line "Nothing runs until you approve."
- **Reduced motion:** tabs become a normal vertical sequence with no pinning.
- **Mobile:** disable the pin. Show the four steps as stacked cards.

### 4.7 Connectors (section 5, dark)

- **Background:** `--bg-page` dark (`#1A110F`), radius 48 px edge at the top, text `--text-on-dark`, secondary `rgba(249,235,235,.7)` (contrast verified on the dark page).
- **Content:** left-aligned H2 (about 6 words) + 30-word paragraph with inline links. Below, a grid of **connector tiles** (4 columns x 3 rows at desktop, 2 columns at 390): Gmail, Google Calendar, Google Drive, Notion, GitHub, Linear, Todoist, Slack, Apple Calendar, Asana, PostHog, and a "Notion Calendar (virtual)" tile.
- **Tile:** 259 x 194 (4:3), radius 24, background `--bg-raised` dark, logo (monochrome Blush-tint), name, and a status line: "Reads", "Reads + drafts", "Read only" so the permission model is visible. Hover: label rises, `translateY(-2px)`, border `--border-strong`.
- **Optional:** the reference warped the gallery into a curved-perspective scroll. Skip it for performance unless time allows. A flat grid is the baseline.
- Link at the end: "See all connectors and permissions →" (docs).
- **Logos:** use each service's official mark within its brand rules, or text-only tiles. Do not imply endorsement.

### 4.8 Local-first explainer (section 6)

- **H2** (about 5 words) + 24-word subhead, centered, on dark continuing from section 5.
- **Diagram (SVG, our own):** `Your apps` → `Local index on your device` → `Local model` **or** `Your API key`. A dashed boundary labeled "Your machine" encloses the first two boxes. Arrows animate left to right once on view.
- **Below the diagram, two columns** (each: H3 18 px, one-line caption, raised pill button with a 36 px arrow chip):
  - **Run local models** → Docs: local setup.
  - **Bring your own API key** → Docs: choosing a model.
- **Bottom edge:** rounded (radius 48) return to the light canvas.
- Honest copy rule: state which tasks stay local by default and which may use an API model only when the user enables it.

### 4.9 Audience bento (section 7)

- **Heading:** H2 + 17-word subhead, centered.
- **Layout:** two cards at 525 x 539 (gap 20) + one full-width card 1070 x 488, radius 28.

| Card | Background | Content |
|---|---|---|
| Students and academics | Periwinkle to canvas-soft gradient | Notebook UI mock: sources, summary, flashcards, deadlines |
| Founders and operators | Blush to Rose gradient (dark Ink text) | Follow-ups, decisions log, commitment tracker mock |
| Product and engineering (wide) | Dark cocoa (`#261816` to `#31201D`) | Specs, threads, issues, "meeting becomes a ticket" mock |

- Each card: H3 (Display 24), 18 to 22-word body, a UI mock built from real app components. Mocks use realistic but fictional content.
- **Hover:** card lifts 2 px, `--shadow-raised-lg`.

### 4.10 Student notebook (section 8)

- Two columns. Left: H2, 30-word paragraph, 4 bullets (verified cited answers, quiz and flashcards with spaced repetition, exam countdown, export to Anki or a Drive source pack). Right: a large notebook UI mock (sources list, cited chat, flashcard).
- Include a one-line academic-integrity statement ("Built to understand and retrieve, not to hand in as your own.").
- CTA: "Read the student guide →".

### 4.11 Privacy and control proof (section 9)

- **Three columns of H3 + short text:** What stays on your device. What can leave (only if you choose an API model, and which tasks). What needs your approval (every write, with the audit log).
- Below: a static **audit log row** and a **local-only badge** rendered as real components. Link: "Read the security model →" and "Delete all your data in one click".
- No claims of certifications or encryption unless the shipped product has them.

### 4.12 Ways to run it (section 10)

Replaces pricing. Three equal cards (344.8 wide, gap 18, radius 26, padding 32) + a slim sponsor row. Remove the billing toggle and credits.

| Card | Content | Primary button |
|---|---|---|
| **Local models** | Fully local, free, needs `{{min hardware}}` | Download |
| **Your API key** | Local app, API model for hard tasks, pay your provider | Download |
| **Self-host** | `{{if applicable}}` | Read the docs |
| Sponsor / contribute row | GitHub Sponsors link, "Good first issues" | Secondary buttons |

The recommended card gets a Blush to Rose gradient and the Pastel Red button; the others use raised secondary buttons. If a hosted tier exists, use a simple two-card Free versus Hosted layout instead.

### 4.13 FAQ (section 11)

- H2 (about 3 words), centered, max 760.
- 10 rows, 940 wide, 82 px closed, native `<details>/<summary>`, hairline dividers (`--border-base`), "+" on the right rotating 45° on open (`.24s`).
- Topics: what is stored and where; deleting data; supported models; offline use; connector permissions; how approvals work; cost; license; recording consent; comparison with cloud assistants. Answers may link to docs. Keep each answer under 80 words.

### 4.14 Final CTA (section 12)

Centered H2 (about 8 words, solid Ink) + 10-word subhead + two buttons (Download primary, Star on GitHub secondary) + the install snippet well. Replaces the reference's second composer.

### 4.15 Footer (section 13)

Raised panel, radius 34, margins 80/24/24. Brand block (logo, 4-word tagline, 15-word blurb). Four link columns: Product, Docs, Community (GitHub, Discord `{{if any}}`, Contributing, Roadmap), Legal (License, Privacy, Security). Bottom bar: © year, Privacy, Terms, Contact, social icons in 32 px (44 px hit) round raised buttons. Mono 12 px small links. No comparison-page link farm.

### 4.16 Landing responsive behavior

| Section | 768 | 390 |
|---|---|---|
| Header | Pill full width, hamburger | Same |
| Hero | H1 42, composer 600 wide | H1 39, composer 358, chips scroll |
| Pinned demo | Pin kept if height allows, else stacked | Stacked cards, no pin |
| Connectors | 3 columns | 2 columns |
| Bento | 1 column (720) | 1 column (358) |
| Ways to run it | **Stack to 1 column** (the reference stayed 3 columns at 768, a flaw) | 1 column |
| FAQ | Rows 720 x 83 | Rows 358 x 94 |
| Footer | One column lists | One column lists |

### 4.17 Landing accessibility and quality gates

- Skip link, one `<main>`, correct heading order, `lang`.
- All text meets AA (Section 2.5). Nav labels at least 12 px.
- All interactive targets at least 44 x 44.
- One focus style everywhere (Section 5.3). No pink or other stray focus colors.
- Real `alt` text on every informative image; decorative images use `alt=""`.
- Lighthouse performance 90+ on mobile, CLS under 0.1.
- No third-party analytics by default. If used, privacy-friendly and disclosed in the page.

---

## 5. APP INTERFACE

Base: the app reference's Home pattern (sidebar plus centered heading and composer, quiet low-contrast chrome, alpha-based layer tokens). Everything beyond Home is **[DECISION]** following common chat-app patterns. **Palette and fonts are ours.**

### 5.1 App shell

```
+-----------+------------------------------------------+--------------+
| Sidebar   |  Main (fluid)                            | Right drawer |
| 240 / 56  |  Home: heading + composer + cards        | (optional)   |
|           |  Thread: scroll column, composer docked  | Source viewer|
|           |                                          | 420 (360-640)|
+-----------+------------------------------------------+--------------+
 Top-right utility pair (incognito/local-only, apps menu) floats over main
```

- **Sidebar:** 240 wide, full height, 1 px right border (`--border-base`), background `--bg-sidebar`. Collapses to a 56 px icon rail with a **320 ms animation** (`--ease-out`); the logo does not re-expand (a dedicated "Open sidebar" button does). Resizable via a separator with `aria-label="Resize sidebar"`.
- **Main:** fluid. Home content is vertically centered. Thread content is a scrolling column (max 720) with the composer docked at the bottom.
- **Right drawer:** opens for the source viewer or details. 320 ms slide from the right. The main column shrinks (it does not get covered) at ≥1024 px; below that the drawer is a full-screen sheet.
- **Top-right utilities:** local-only badge and an apps menu, floating over main; no header bar on Home.
- **Recording pill:** when recording, a persistent top-center pill (Section 5.7) overrides the utility area.

### 5.2 Sidebar anatomy [measured values kept]

| Element | Spec |
|---|---|
| Logo link | 40 x 40 at (8, 8), radius 12 |
| Collapse button | 32 x 32 visual, 44 hit, radius 12 |
| Nav row | 224 x 40, x=8, 1 px gap, radius 12, icon 20 px, label 14 / 350 / 20, color `--text-primary` |
| Row hover | `--layer-subtle`, 180 ms |
| Row selected | `--accent-soft` background, `--text-primary`, 3 px left indicator in `--accent-strong`, icon in `--accent-strong` |
| Shortcut hint | 12 / 16, `--text-tertiary`, right aligned |
| Section header | 224 x 32, radius 8, 14 / 350 / 20, `--text-tertiary`; 24 px icon buttons (Create, Filter, Collapse) with 44 hit area |
| Empty list text | 14 / 350 / 20, `--text-tertiary` |
| Badge | 11 / 440 pill, `--accent` fill with Ink text (pending approvals count) |
| Account row | Pinned bottom, avatar or initial, name, chevron; menu opens above |

**Navigation items (top to bottom):** New (`Ctrl+N`), Home, Ask, Notebooks, Meetings, Commitments, Actions (badge), Connectors, Routines, then collapsible sections **Notebooks** (list, with create) and **Sessions** (recent chats, with filter), then Settings in the account menu.

**Collapsed rail:** icon-only column of the same items with tooltips (right side, 8 px offset, 300 ms delay), avatar at the bottom.

### 5.3 Global interaction rules

- **Focus ring:** 2 px `--focus-ring` with 2 px offset in the surface color. Same style everywhere, on every focusable element.
- **Hit areas:** 44 x 44 minimum even when the visual is 32.
- **Names:** every icon-only button has an `aria-label`. Chips, send button and the composer have accessible names (the reference lacked several).
- **Command palette** `Ctrl/Cmd+K`: search across notebooks, sessions, commitments, actions and commands. [DECISION]
- **Keyboard shortcuts (proposal):** `Ctrl+N` new session, `Ctrl+K` palette, `Ctrl+B` toggle sidebar, `Ctrl+/` shortcuts help, `/` focus composer, `Esc` close drawer or dialog, `Ctrl+Enter` send in multiline mode.
- **Hover transitions:** 180 ms (`--ease-ui`), never instant.
- **Reduced motion:** honored (Section 3.5).

### 5.4 Composer [measured structure kept, details adapted]

| Part | Spec |
|---|---|
| Card | Home: 504 x 118 with sidebar open, 638 collapsed. Background `--bg-raised`, radius 16, padding 12, `--shadow-raised-md` (light) / elevation tokens (dark). Border 0.8 px transparent, edge from shadows |
| Input | Auto-growing `<textarea>` (not `contenteditable`, for accessibility) [DECISION], 16 / 350 / 24, min 52, max 240 then scrolls |
| Placeholder | **Static**: "Ask about your work…" with a small helper line below the card: "Type @ for sources, / for modes". The rotating placeholder of the reference is not used (reads as flicker) |
| Toolbar | 32 px round buttons (44 hit), `--r-full` |
| Left controls | "+" Add files or tools; **Scope chip** (Everything / a Notebook / a Connector, with caret); **Mode chip** (Ask, Study, Draft) |
| Right controls | **Model chip** (name + **Local** or **API** badge); dictation; send |
| Send | 32 circle, `--accent` fill, Ink arrow icon; disabled state `--layer-subtle` with `--text-tertiary` icon; while streaming becomes a Stop button (square icon) |
| Focus | Border glow: `0 0 0 3px rgba(145,94,86,.25)` plus the focus ring on the textarea |
| Footer meta (optional) | Budget meter and "Data leaves device" or "Local only" badge (Section 5.7) |

**Drag-and-drop:** dropping files onto the page shows a full-main dashed overlay "Drop to add to {{scope}}" in `--accent-soft` with a 2 px dashed `--accent-strong` border.

### 5.5 Thread view (Ask) [DECISION, no reference measured]

- **Layout:** centered column, max 720, vertical rhythm 24 px between turns. Composer docked bottom with a 24 px gradient fade above it. "Scroll to latest" circular button (44) appears when not at the bottom.
- **User message:** right aligned, `--accent-soft` background, `--text-primary`, radius 16 (4 px on the tail corner), max width 80%, 16 / 24.
- **Assistant message:** left aligned, no bubble, `--font-answer`, 16 / 26, `--text-primary`. Inline **citation chips** (Section 5.7) after the sentence they support.
- **Verification state line (above each answer):** small Mono 12 label: `Checked against 4 sources` (success tone icon) or `1 statement could not be verified` (warning tone icon) or `Not found in your sources` (neutral). This is a product differentiator and must be visible.
- **Hover actions (below message):** Copy, Retry, Open sources, Save to notebook, Thumbs. 32 visual / 44 hit, appear on hover and on focus within. On touch they are always visible.
- **Tool and action requests:** rendered as **approval cards** inline (Section 5.7), never auto-executed.
- **Streaming:** text appends; a 8 px pulsing dot in `--accent-strong` at the end; composer send becomes Stop. Respect reduced motion (no pulse, static dot).
- **Empty state:** the Home pattern (centered heading, composer, suggestion cards).

### 5.6 Screens (10)

Each screen below uses the shell above. "Reuses" lists components already defined.

**1. Home / Brief**
- Heading 24 / 350 / 32, left-aligned to the composer edge: a time-aware greeting is optional; default "What do you want to know?" Composer below.
- **Brief sections** below the composer as cards (314 x 88 pattern widened to a responsive grid, radius 11 to 16, padding 16, gradient of Periwinkle-to-Blush at the top-right): Today's meetings, Open commitments, Due soon, Needs your approval. Each card: icon, title 14 / 440, one-line status, count badge.
- Reuses: composer, card, badge.

**2. Ask**
- The thread view (5.5). Scope chip shows Everything or a Notebook. Right drawer: source viewer.

**3. Notebooks**
- **List:** grid of notebook cards (course name, term, source count, next exam date, progress ring), radius 16, raised-sm. "New notebook" card with dashed border.
- **Detail:** tabs (Chat, Sources, Study, Mind map, Exports). Header shows scope (sources, tags, date range) and the **Local only** toggle for this notebook. Sources tab: list rows with type icon, name, sync status, remove.

**4. Study**
- Centered card flow. **Quiz:** question card (radius 16, padding 32), 4 options as full-width rows, answer-first: user selects, then feedback with explanation and citation chips. **Flashcards:** centered card 560 x 340, flip `--dur-flip` (disabled under reduced motion), rating buttons below (Again, Hard, Good, Easy) 44 high. **Review queue:** count, due today, streak optional. **Exam countdown:** compact card with days left and weakest topics.

**5. Meetings**
- **List:** rows (title, date, duration, source, commitments count).
- **Detail:** two panes. Left: summary, commitments, decisions. Right: **transcript view** (Section 5.7): speaker label, timestamp chip, text; clicking a timestamp seeks the audio player docked at the bottom (play, scrub, speed).
- **Record:** a primary button opens the consent dialog, then the recording pill.

**6. Commitments and Decisions**
- Two tabs. Table with rows: text, owner, due date (relative + absolute), status (badge), source link (citation chip). Filters: owner, status, date range. Overdue rows show a `--danger` icon plus the word "Overdue". Row click opens the source in the drawer.

**7. Actions**
- Two tabs: **Approval queue** and **Audit log**. Queue: stacked **approval cards**. Log: **audit-log rows**. Filter chips by status (Draft, Approved, Rejected, Executed, Failed). Failed rows show an error line and Retry.

**8. Connectors**
- Grid of **connector health cards** (12). Header actions: Connect, Test, Sync now. Detail drawer: scopes granted, last sync, cursor, sync log, Disconnect.

**9. Routines**
- List of routines (Morning brief, Weekly report, Deadline digest, custom) with a schedule summary and an on/off switch. Detail: schedule editor (time, days), template editor (text area with variables), last run output, "Run now".

**10. Settings**
- Left sub-nav: General, Models, Privacy and data, Budget, Appearance, Shortcuts, Data deletion.
- **Models:** per-task policy table (task, default, escalation), provider keys (masked, stored in the OS keychain, never shown after save), **Local-only mode** switch (global).
- **Privacy and data:** what is stored, export, **Delete everything** (danger button, requires typing the word DELETE).
- **Budget:** monthly cap input, usage meter, behavior at cap (block with explanation).
- **Appearance:** theme (Light, Dark, System), answer font, density.

### 5.7 New components the reference lacks [DECISION, specs]

**Citation chip**
- Inline pill, 12 / 440, height 20 (hit area 28 min on touch, expanded with padding), radius 9999, `--layer-subtle` background, `--text-secondary`, source-type icon 12 px + index ("1"). Hover: `--layer-strong`, tooltip with source title and location. Click opens the source drawer at the exact anchor. Focus ring standard. Cocoa never used for chip text.

**Source viewer (right drawer)**
- Header: source title, type icon, location ("p. 12", "04:31", "message from Priya"), Open original, Close. Body: rendered source with the cited span **highlighted** in `--accent-soft` with a 2 px `--accent-strong` left bar; PDF pages render as images; transcripts show a window around the timestamp. Footer: "Open in app", "Copy link to anchor".

**Approval card**
- Raised surface, radius 16, padding 16. Header: action icon, "Create task in {{app}}", risk badge (Low, Medium, High). Body: **exact payload** in a mono block on `--bg-sunken` (radius 12, 13 px). Source citation chips below. Footer: Approve (primary, Pastel Red), Reject (outline), Edit (ghost). Always shows "Nothing runs until you approve." After approval, the card collapses to a status row with the result link.

**Audit-log row**
- 56 px high: timestamp (Mono 12), actor (You, Routine, Assistant), action, target, status badge, expand chevron revealing the payload. Rows are append-only: no delete control.

**Connector health card**
- 280 x 160, radius 16: logo, name, status dot + word (Connected, Syncing, Needs reconnect, Error), last sync time (relative), permissions line ("Reads, drafts"), actions (Sync now, Reconnect). Dot colors use status tokens, never alone.

**Recording pill and consent dialog**
- Pill: top-center, height 40, `--danger` 8 px pulsing dot (static under reduced motion), "Recording" + timer in Mono, Stop button, Pause. Always visible while recording, `z-index: 80`.
- First-use consent dialog: modal 480 wide, title "Before you record", plain text on local storage and consent laws, checkbox "I have permission from everyone on this call", Cancel and Start recording (primary disabled until checked).

**Local-only / data-leaves-device badge**
- Pill 28 high in the composer footer and top-right: **Local only** (`--accent-soft`, shield icon) or **Data leaves device** (`--warning`-tinted, arrow-out icon, tooltip naming the provider and task). Clicking opens Privacy settings. Per-notebook override shown on that notebook.

**Budget meter**
- 4 px bar (`--bg-sunken` track, `--accent-2` fill; turns `--warning` at 80% and `--danger` at 100%) with a numeric label ("$3.20 of $10.00") in tabular figures. At the cap: composer shows an inline notice explaining that API calls are paused and offering local mode.

**Quiz and flashcard card:** see screen 4.

**Mind-map canvas**
- Full-bleed pan/zoom canvas on `--bg-sunken` with a dot grid, floating toolbar (zoom in/out, fit, export). Nodes: radius 12 pills, `--bg-raised`, selected node has the focus ring. Edges 1.5 px `--border-strong`. Keyboard: arrow keys move selection, Enter expands.

**Transcript view:** row = speaker label (Mono 12, `--text-secondary`), timestamp chip (clickable, `--layer-subtle`), text 16 / 26. Current playback row highlighted with `--accent-soft`. Unknown speaker shows "Speaker 1".

### 5.8 Overlays [DECISION]

| Overlay | Spec |
|---|---|
| Modal | 480 default, radius 24, `--bg-overlay`, `--shadow-raised-lg`, scrim `--scrim`, entry 240 ms fade + 8 px rise, exit 160 ms, focus trapped, Esc and scrim click close (not for destructive confirms) |
| Popover / menu | Radius 16, padding 8, rows 40, `--shadow-float`, entry 160 ms; arrow-key navigation |
| Tooltip | Radius 8, 12 px text, 300 ms delay, `--ink` background with `--blush-tint` text (dark theme inverts) |
| Toast | Bottom-center, radius 16, 360 max width, 4 s (errors persist until dismissed), `role="status"` |
| Banner | Top of main, `--blush-tint` background, icon + one line + action, dismissible |
| Command palette | 640 wide, radius 24, search input 56 high, results rows 44 |

### 5.9 States and feedback [DECISION]

| State | Treatment |
|---|---|
| Loading list | Skeleton rows (`--layer-subtle`, 1.2 s shimmer, disabled under reduced motion) |
| Streaming | Pulsing dot, Stop button |
| Empty | Icon, one line, one action (for example "No notebooks yet. Create one.") |
| Sync error | Connector card turns "Error" with the reason and Retry |
| Model unavailable | Inline notice with fallback offered ("Switch to {{model}}") |
| Budget cap reached | Composer notice (Section 5.7) |
| Offline | Banner: "You are offline. Local features still work." |
| Permission denied (mic, files) | Inline explanation with steps |
| Destructive actions | Confirm dialog naming exactly what is deleted |

### 5.10 App responsive behavior [DECISION, reference not measured]

| Width | Behavior |
|---|---|
| ≥1280 | Sidebar 240 + main + drawer inline |
| 1024 | Sidebar auto-collapses to rail; drawer overlays main |
| 768 | Sidebar becomes an off-canvas drawer opened by a menu button; composer full width minus 32 |
| ≤480 | Single column; composer docked full-bleed with safe-area padding; drawers are full-screen sheets; cards stack; icon buttons keep 44 hit areas |

### 5.11 App theming

`data-theme` attribute on `:root` with values `light`, `dark`, or absent (follows `prefers-color-scheme`). Surface hierarchy in dark: underlay `#130C0B`, page `#1A110F`, raised `#261816`, overlay `#31201D`. Alpha layers (3% and 6% of the foreground) generate hover and selected tints in both themes. Do not hardcode hex in components; use semantic tokens only.

---

## 6. COMPONENT STATE MATRIX

Every interactive component implements: default, hover, focus-visible, active/pressed, selected, disabled, loading (where applicable), error (inputs).

| Component | Hover | Pressed | Disabled | Notes |
|---|---|---|---|---|
| Primary button | `--accent-hover`, `translate(2px,-2px)` landing only | `--accent-pressed`, `--shadow-inset-sm` | `--layer-subtle` bg, `--text-tertiary` | Text always Ink |
| Secondary button | `--layer-subtle` over raised, lift 1 px | `--shadow-inset-sm` | 50% opacity | |
| Ghost button | `--layer-subtle` | `--layer-strong` | 50% opacity | |
| Icon button | `--layer-subtle` | `--layer-strong` | 40% opacity | 44 hit |
| Nav row | `--layer-subtle` | `--layer-strong` | n/a | |
| Chip | `--layer-strong` | `--layer-strong` | 50% | |
| Input | border `--border-strong` | n/a | `--layer-faint` | Error: `--danger` border + message |
| Toggle | Track `--bg-sunken` off, `--accent` on, thumb raised | | 50% | Label required |
| Card (clickable) | lift 2 px + `--shadow-raised-lg` | `--shadow-inset-sm` | | |
| Row (table) | `--layer-subtle` | | | |

---

## 7. IMAGERY AND ICONOGRAPHY

- **Product imagery first:** real app screens rendered with real components (screenshots or live SVG/HTML mocks) on soft Periwinkle, Blush or dark cocoa backdrops. No stock photography. No AI-generated people.
- **Illustration:** minimal. Diagrams in SVG using palette tokens, 1.5 px strokes, radius 12.
- **Icons:** thin outline, 1.5 px stroke, 20 px glyph in 32 / 44 hit areas, colored `--ink` or `--accent-strong`. Suggested library: Lucide (open-source), subject to your choice. One set only.
- **Image rules:** radius 24 to 28, no borders, soft raised shadow when floating, WebP/AVIF, explicit width and height, `loading="lazy"` below the fold, alt text on informative images.
- **Video:** muted, `playsinline`, looped, `preload="none"`, poster image, WebM under 500 KB per clip.

---

## 8. ACCESSIBILITY CHECKLIST (applies to landing and app)

1. All text at least 4.5:1 (large text 3:1); use only tokens approved in Section 2.5.
2. Never convey meaning by color alone.
3. 44 x 44 minimum interactive area.
4. Visible focus on every focusable element; logical tab order; focus trapped in dialogs and returned on close.
5. Landmarks (`header`, `nav`, `main`, `aside`, `footer`), skip link, correct heading hierarchy.
6. Accessible names on all controls, including the composer, mode chips and send.
7. Citation chips and verification status are readable by screen readers ("Source 1, Meeting with Priya, 12 minutes in").
8. Live regions: toasts `role="status"`, errors `role="alert"`, streaming responses `aria-live="polite"` and `aria-busy` while writing.
9. `prefers-reduced-motion` honored everywhere (Section 3.5).
10. Dark theme verified separately for contrast.
11. Keyboard parity for all drag-and-drop and mind-map interactions.

---

## 9. IMPLEMENTATION NOTES FOR CLAUDE CODE

- Implement tokens once (`tokens.css`) and consume only semantic variables in components. Mirror them in Tailwind via CSS variables if Tailwind is used.
- Build components before screens: Button, IconButton, Chip, Badge, Input/Textarea, Toggle, Card, Row, Tooltip, Popover/Menu, Modal, Drawer, Toast, Skeleton, then Composer, CitationChip, SourceViewer, ApprovalCard, AuditRow, ConnectorCard, RecordingPill, LocalBadge, BudgetMeter, Flashcard, Quiz, MindMap, Transcript.
- Add a `/design` route (dev only) that renders every component in every state in light and dark. Use it as the visual regression and accessibility test page.
- Automated checks: axe for accessibility, contrast assertions for token pairs listed in Section 2.5, Lighthouse for the landing page.
- Landing page: static, no framework required for the marketing site; keep JS per section and lazy-load the demo. App: web UI served by the local daemon.
- Do not add colors outside Sections 2.1 to 2.4. If a new color is needed, propose it with a contrast calculation first.

---

## 10. WHAT TO BORROW, WHAT TO FIX, WHAT WE ADDED

| | Kept from references | Fixed | Added by us |
|---|---|---|---|
| Landing | Floating pill header, hero-as-product, pinned input-to-output demo, one dark section, bento, native-details FAQ, quiet short headlines, one material system | Secondary text contrast, 10 px nav labels, system-serif headings, media weight, no social proof, pricing stayed 3-col at 768, stray focus colors, 16 breakpoints | Trust strip, connectors grid, local-first diagram, student section, privacy proof, install snippet, GitHub star CTA, reduced-motion plan |
| App | 240/56 sidebar, 224 x 40 rows, 16 px composer radius, alpha layer tokens, centered Home | Instant transitions, 32 px touch targets, unnamed controls, tertiary text contrast, rotating placeholder flicker, `contenteditable` composer | Citation chips, source viewer, approval card, audit log, connector health, recording pill and consent, local badge, budget meter, quiz and flashcards, mind map, transcript view, full screen set, dark theme from palette |

---

## 11. APPENDIX: TOKEN QUICK TABLE

| Role | Light | Dark |
|---|---|---|
| Page | `#EAEEF4` | `#1A110F` |
| Sidebar | `#DDE4ED` | `#150E0C` |
| Raised | `#F8F9FB` | `#261816` |
| Overlay | `#F8F9FB` | `#31201D` |
| Sunken | `#D0D9E6` | `#130C0B` |
| Text primary | `#2E1E1C` | `#F9EBEB` |
| Text secondary | `#50342F` | `#9DA1AA` |
| Text tertiary | `#6D4640` | `#7E7F85` (page bg only) |
| Primary action | `#E67E7F` (text `#2E1E1C`) | `#E67E7F` (text `#2E1E1C`) |
| Link / strong accent | `#915E56` | `#EDB0B1` |
| Selected / soft accent | `#F2D3D3` | `rgba(230,126,127,.16)` |
| Secondary accent | `#EDB0B1` | `#EDB0B1` |
| Focus ring | `#915E56` | `#EDB0B1` |
| Success / Warning / Danger / Info | `#2F6B49` / `#86580F` / `#B23A48` / `#3F6299` | `#7FC79A` / `#E0B060` / `#F08A94` / `#8FB2E6` |
