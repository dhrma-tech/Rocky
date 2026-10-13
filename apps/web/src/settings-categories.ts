/** Settings categories (UI spec 18), shared by Settings and the command palette. */
export const CATEGORIES = [
  { id: "general", title: "General", words: "data folder import files" },
  { id: "rules", title: "Permissions and rules", words: "allow ask block grant approval safety" },
  { id: "model", title: "Model", words: "ollama local api key budget speed" },
  { id: "memory", title: "Memory", words: "remember profile" },
  { id: "privacy", title: "Privacy and data", words: "local only encryption delete" },
  { id: "appearance", title: "Appearance", words: "theme dark light" },
  { id: "advanced", title: "Advanced", words: "ollama url port" },
  { id: "about", title: "About", words: "version licence" },
] as const;
export type Category = (typeof CATEGORIES)[number]["id"];
