import { defineConfig } from "vite";

/**
 * Repo facts for the trust strip, fetched once at build time (DESIGN §4.5: no runtime
 * third-party request). Any failure hides the item instead of showing a wrong number.
 */
async function repoFacts(): Promise<{ stars: number | null; contributors: number | null }> {
  const api = "https://api.github.com/repos/dhrma-tech/Rocky";
  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "rocky-landing-build" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(String(res.status));
    return res;
  };
  try {
    const repo = (await (await get(api)).json()) as { stargazers_count?: number };
    const people = (await (
      await get(`${api}/contributors?per_page=100&anon=1`)
    ).json()) as unknown[];
    return {
      stars: repo.stargazers_count ?? null,
      contributors: Array.isArray(people) ? people.length : null,
    };
  } catch {
    return { stars: null, contributors: null };
  }
}

export default defineConfig(async () => ({
  define: { __REPO_FACTS__: JSON.stringify(await repoFacts()) },
  server: { host: "127.0.0.1", port: 5174 },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
}));
