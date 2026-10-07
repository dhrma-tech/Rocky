// Landing page behavior. No network requests: repo facts are injected at build time, and the
// demos are scripted and labeled "Sample" (DESIGN §4.1).
import "@fontsource-variable/inter/wght.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";

declare const __REPO_FACTS__: { stars: number | null; contributors: number | null };

const $ = <T extends Element>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(sel),
];
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Private mode or blocked storage: the bar just shows again next time.
    }
  },
};

// --- Announcement bar (dismissible, remembered) ---
const announce = $<HTMLElement>("[data-announce]");
if (announce && store.get("rocky-announce") === "dismissed") announce.hidden = true;
$("[data-dismiss]")?.addEventListener("click", () => {
  if (announce) announce.hidden = true;
  store.set("rocky-announce", "dismissed");
});

// --- Repo facts (build time) ---
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const { stars, contributors } = __REPO_FACTS__;
// A zero count proves nothing; show stars once there are some.
if (stars !== null && stars > 0) {
  const el = $<HTMLElement>("[data-stars]");
  if (el) {
    el.textContent = `★ ${fmt(stars)}`;
    el.hidden = false;
  }
  const li = $<HTMLElement>('[data-fact="stars"]');
  const a = li?.querySelector("a");
  if (li && a) {
    a.textContent = `★ ${fmt(stars)} on GitHub`;
    li.hidden = false;
  }
}
if (contributors !== null && contributors > 0) {
  const li = $<HTMLElement>('[data-fact="contributors"]');
  const a = li?.querySelector("a");
  if (li && a) {
    a.textContent = `${contributors} contributor${contributors === 1 ? "" : "s"}`;
    li.hidden = false;
  }
}
const year = $("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());

// --- Mobile drawer (focus trapped, Esc closes) ---
const drawer = $<HTMLElement>("#drawer");
const menuBtn = $<HTMLButtonElement>("[data-menu]");
function closeDrawer() {
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  menuBtn?.setAttribute("aria-expanded", "false");
  menuBtn?.focus();
}
menuBtn?.addEventListener("click", () => {
  if (!drawer) return;
  drawer.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
  $<HTMLElement>("a, button", drawer)?.focus();
});
$("[data-menu-close]")?.addEventListener("click", closeDrawer);
drawer?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (!drawer || drawer.hidden) return;
  if (e.key === "Escape") closeDrawer();
  if (e.key === "Tab") {
    const items = $$<HTMLElement>("a, button", drawer);
    const first = items[0];
    const last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});

// --- Copy install command ---
const toast = $<HTMLElement>("[data-toast]");
let toastTimer: number | undefined;
for (const btn of $$<HTMLButtonElement>("[data-copy]"))
  btn.addEventListener("click", async () => {
    const code = btn.parentElement?.querySelector("code")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
      if (toast) toast.textContent = "Copied";
    } catch {
      if (toast) toast.textContent = "Select the text to copy it";
    }
    if (!toast) return;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2000);
  });

// --- Hero sample questions (scripted, no network) ---
const SAMPLES = [
  {
    answer:
      'You agreed to keep the current price for existing customers and raise it 10% for new ones from 1 November <span class="cite">1</span>.',
    sources: ["Pricing call · 3 Oct · 24:10"],
    scope: 0,
  },
  {
    answer:
      'Priya has not replied about the Q3 numbers you asked for on Monday <span class="cite">1</span>, and the vendor is waiting on your signed order form <span class="cite">2</span>.',
    sources: ["Email to Priya · Mon", "Email from the vendor · Tue"],
    scope: 1,
  },
  {
    answer:
      'Question 1 of 5: What shifts the demand curve, rather than moving along it? <span class="cite">1</span>',
    sources: ["ECON 101 · Lecture 4 · slide 12"],
    scope: 4,
  },
];
const q = $<HTMLElement>("[data-q]");
const answer = $<HTMLElement>("[data-answer]");
const scopes = $$<HTMLElement>(".scope");
let typing: number | undefined;
for (const btn of $$<HTMLButtonElement>("[data-sample]")) {
  btn.setAttribute("aria-pressed", "false");
  btn.addEventListener("click", () => {
    const s = SAMPLES[Number(btn.dataset.sample)];
    if (!s || !q || !answer) return;
    for (const b of $$<HTMLButtonElement>("[data-sample]"))
      b.setAttribute("aria-pressed", String(b === btn));
    scopes.forEach((el, i) => {
      el.classList.toggle("is-open", i === s.scope);
    });
    const text = btn.textContent ?? "";
    answer.hidden = true;
    window.clearInterval(typing);
    const show = () => {
      // Fixed, trusted sample markup only; nothing here comes from user input.
      answer.innerHTML = `<p>${s.answer}</p><ol class="sources small">${s.sources
        .map((src, i) => `<li><span class="cite">${i + 1}</span> ${src}</li>`)
        .join("")}</ol>`;
      answer.hidden = false;
    };
    if (reduced) {
      q.textContent = text;
      show();
      return;
    }
    let n = 0;
    q.textContent = "";
    typing = window.setInterval(() => {
      n++;
      q.textContent = text.slice(0, n);
      if (n >= text.length) {
        window.clearInterval(typing);
        window.setTimeout(show, 350);
      }
    }, 28);
  });
}

// --- Pinned demo: scroll steps through the tabs; tabs are also clickable ---
const tabs = $$<HTMLButtonElement>("[data-step]");
const panels = $$<HTMLElement>("[data-panel]");
function setStep(i: number) {
  tabs.forEach((t, j) => {
    t.setAttribute("aria-selected", String(i === j));
  });
  panels.forEach((p, j) => {
    p.classList.toggle("is-active", i === j);
  });
}
for (const t of tabs) t.addEventListener("click", () => setStep(Number(t.dataset.step)));
const panel = $<HTMLElement>(".demo-panel");
const pinned = window.matchMedia(
  "(min-width: 900px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)",
);
function onScroll() {
  if (!panel || !pinned.matches) return;
  const r = panel.getBoundingClientRect();
  const travel = r.height - window.innerHeight;
  if (travel <= 0) return;
  const progress = Math.min(Math.max(-r.top / travel, 0), 0.999);
  setStep(Math.floor(progress * tabs.length));
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// --- Diagram arrows draw once on view ---
const diagram = $<SVGElement>(".diagram");
if (diagram && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      diagram.classList.add("is-visible");
      io.disconnect();
    }
  });
  io.observe(diagram);
} else diagram?.classList.add("is-visible");
