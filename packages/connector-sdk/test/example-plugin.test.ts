// The plugin in examples/rss-plugin is the one CONTRIBUTING.md walks through. This keeps the guide
// honest: it must load through the real plugin loader and sync against a replayed feed.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlugins } from "../src/index.ts";
import { replay, runSync } from "../src/testing.ts";

const dir = path.resolve(import.meta.dirname, "../../../examples/rss-plugin");
const FEED = "https://example.org/feed.xml";
const xml = `<?xml version="1.0"?><rss><channel>
<item><title>Release 1.2</title><link>https://example.org/1.2</link><guid>r-1.2</guid>
<pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Adds <b>offline</b> mode.</p>]]></description></item>
<item><title>Release 1.1</title><link>https://example.org/1.1</link><guid>r-1.1</guid>
<pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate><description>Bug fixes.</description></item>
</channel></rss>`;

describe("example RSS plugin (CONTRIBUTING.md)", () => {
  it("loads through config.plugins and syncs only new items", async () => {
    const [r] = await loadPlugins([pathToFileURL(dir).href]);
    expect(r?.error).toBeUndefined();
    const rss = r?.connectors[0];
    if (!rss) throw new Error("plugin not loaded");
    expect(rss.id).toBe("rss");

    const first = await runSync(rss, {
      fetch: replay([{ url: FEED, body: xml, headers: { "content-type": "application/rss+xml" } }])
        .fetch,
      config: { url: FEED },
    });
    expect(first.documents.map((d) => d.title)).toEqual(["Release 1.2", "Release 1.1"]);
    const unit =
      first.documents[0]?.body.kind === "text" ? first.documents[0].body.units?.[0] : null;
    expect(unit?.text).toBe("Adds offline mode.");

    const second = await runSync(rss, {
      fetch: replay([{ url: FEED, body: xml }]).fetch,
      config: { url: FEED },
      cursor: first.cursor,
    });
    expect(second.documents).toEqual([]);
  });
});
