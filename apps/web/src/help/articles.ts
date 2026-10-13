/**
 * Help articles (UI spec 20). They ship inside the app, so Help works offline. Keep each one
 * short, true for this build, and free of anything Rocky can't do yet.
 */

export const HELP_CATEGORIES = [
  "Start here",
  "Approvals and safety",
  "Memory",
  "Integrations",
  "Troubleshooting",
] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

export interface Article {
  id: string;
  category: HelpCategory;
  title: string;
  summary: string;
  body: string[];
  words: string;
  /** A screen to go to from the article. */
  link?: { to: string; label: string };
}

export const ARTICLES: Article[] = [
  {
    id: "what-rocky-does",
    category: "Start here",
    title: "What Rocky does",
    summary: "Remembers your sources, answers with citations, drafts, and waits for approval.",
    body: [
      "Rocky reads the files, mail, calendars and notes you connect and keeps them in one store on this computer.",
      'When you ask a question, every sentence of the answer cites the passage it came from. If your sources don\'t say, Rocky answers "Not found in your sources" instead of guessing.',
      "Rocky can draft things, like an email reply or a calendar event, but nothing leaves this computer until you approve it. Emails are only ever saved as drafts.",
    ],
    words: "overview intro introduction about",
  },
  {
    id: "ask-and-check",
    category: "Start here",
    title: "Ask a question and check the answer",
    summary: "Every sentence links to its source; open one to see the exact passage.",
    body: [
      'Open Ask (or press Ctrl+K and choose "Ask Rocky a question") and type your question.',
      "Each sentence in the answer has a citation. Select it to open the source with the quoted passage highlighted.",
      'Sentences Rocky couldn\'t match to a source are dropped, not shown. If nothing matched, you see "Not found in your sources" and the closest passages it found.',
      "On a local model an answer can take a minute or two. Settings > Model shows the speed measured on this computer.",
    ],
    words: "chat question citation source verify answer slow",
    link: { to: "/ask", label: "Ask a question" },
  },
  {
    id: "routines",
    category: "Start here",
    title: "Set up a routine",
    summary: "A cited summary of your sources on a schedule, such as a morning brief.",
    body: [
      "Go to Tasks > Background and choose New routine. Start from a template or a blank routine, pick a schedule, and choose what it reads.",
      "Routines only write summaries. They never send or change anything.",
      "If the computer was asleep at the scheduled time, the routine runs once when it wakes.",
      "A routine that fails three times in a row pauses itself and moves to the top of Background with the reason.",
    ],
    words: "schedule brief morning background automation",
    link: { to: "/tasks/background", label: "Open Background" },
  },
  {
    id: "approvals",
    category: "Approvals and safety",
    title: "How approvals work",
    summary: "Nothing outside this computer changes until you approve it.",
    body: [
      "Anything that would change something outside Rocky, such as a draft in Gmail or a calendar event, waits in Approvals.",
      "Each card shows what will happen, where, and the exact payload. Your approval is tied to that payload: if it changes, it needs approving again.",
      "After you approve, Rocky waits 10 seconds before running it, so you can press Undo.",
      "Rocky never sends email. It saves drafts for you to send yourself.",
      "Every decision is written to the ledger, which can't be edited after the fact.",
    ],
    words: "approve deny undo draft email payload hash ledger audit",
    link: { to: "/approvals", label: "Open Approvals" },
  },
  {
    id: "rules",
    category: "Approvals and safety",
    title: "Rules: allow, ask and block",
    summary: "Let Rocky skip the question for one narrow kind of action, for a limited time.",
    body: [
      "In Settings > Permissions and rules you can make a rule that blocks, asks about, or allows a kind of action.",
      "An allow rule needs an action type, a condition and an end date no more than 90 days away. If any rule says ask, Rocky asks.",
      "Allow never applies to sending, spending or deleting, or to proposals that came from content Rocky read. Those always wait for you.",
    ],
    words: "permissions allow block grant always policy",
    link: { to: "/settings", label: "Open Settings" },
  },
  {
    id: "local",
    category: "Approvals and safety",
    title: "What stays on this computer",
    summary: "Local-only mode keeps every model call on this machine.",
    body: [
      "With local-only on, Rocky only uses models running on this computer through Ollama, and no text leaves it.",
      "If you add an API key and turn local-only off, some tasks can use a cloud model. A monthly budget cap stops cloud use when it is reached.",
      "Keys and sign-in tokens are kept in your operating system's keychain, never in files.",
    ],
    words: "privacy local only offline cloud api key budget keychain",
    link: { to: "/settings", label: "Privacy settings" },
  },
  {
    id: "memory",
    category: "Memory",
    title: "What Rocky remembers",
    summary: "Plain files you can read, edit and export. Rocky asks before it saves anything.",
    body: [
      "Memory is a set of Markdown files in your data folder. Every fact notes who stated it and when.",
      "When Rocky learns something, it proposes it first; it lands in Memory only after you accept it.",
      "You can edit or delete any line on the Memory screen, or export everything with `rocky memory export`.",
    ],
    words: "remember facts profile forget export",
    link: { to: "/memory", label: "Open Memory" },
  },
  {
    id: "connect",
    category: "Integrations",
    title: "Connect a tool",
    summary: "Each integration is marked supported, experimental or link-only.",
    body: [
      "Open Integrations and choose Connect on a tool. Sign-in tokens go to your operating system's keychain and are never shown again.",
      "Supported integrations pass a live test every night. Experimental ones work but aren't tested that way yet. Link-only ones open the app but hold no data.",
      "Content Rocky reads from a tool is treated as information, never as instructions.",
    ],
    words: "gmail calendar drive github notion connector sign in token",
    link: { to: "/connectors", label: "Open Integrations" },
  },
  {
    id: "engine-down",
    category: "Troubleshooting",
    title: "Rocky's engine isn't responding",
    summary: "The background engine stopped. Start it again and reopen Rocky.",
    body: [
      "The app talks to an engine running on this computer. If it stops, you see a red banner and the page becomes read-only.",
      "In a terminal, run `rocky daemon`, then press Retry. If the browser asks you to sign in, run `rocky open` and open the link it prints.",
      "To have the engine start when you sign in, run `rocky daemon install`.",
    ],
    words: "daemon down offline not responding banner start",
  },
  {
    id: "model",
    category: "Troubleshooting",
    title: "Answers are slow or no model is found",
    summary: "Check that Ollama is running and a model is downloaded.",
    body: [
      "Rocky uses Ollama to run models on this computer. If it isn't installed, get it from ollama.com/download.",
      "Settings > Model shows which models fit this computer and lets you download the recommended one.",
      "Run diagnostics on this page to check Ollama, the models and free disk space. `rocky doctor --fix` can repair most of these.",
    ],
    words: "ollama model slow speed download not found",
    link: { to: "/settings", label: "Model settings" },
  },
  {
    id: "routine-paused",
    category: "Troubleshooting",
    title: "A routine paused itself",
    summary: "It failed three times in a row. Fix the cause, then switch it back on.",
    body: [
      "Background shows the routine at the top with its last error.",
      "The most common cause is that Ollama isn't running, or the routine's model isn't downloaded.",
      "Fix the cause, then switch the routine back on, or press Run now to try it once.",
    ],
    words: "routine failed paused error",
    link: { to: "/tasks/background", label: "Open Background" },
  },
];

/** The three most common problems, shown first (UI spec 20). */
export const COMMON = ["engine-down", "model", "routine-paused"];

export function searchArticles(query: string): Article[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ARTICLES.filter((a) => {
    const hay = `${a.title} ${a.summary} ${a.words} ${a.body.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
