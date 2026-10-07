// Example Rocky connector plugin: an RSS feed, read-only. CONTRIBUTING.md walks through it.
// Plain JavaScript so it also works when published to npm (Node does not strip types inside
// node_modules). The connector shape is the SDK's `Connector` type (packages/connector-sdk).
import { z } from "zod";

const ITEM = /<item>([\s\S]*?)<\/item>/g;
/** Text of the first <name>…</name> in `xml`, without a CDATA wrapper. */
const tag = (xml, name) => {
  const start = xml.indexOf(`<${name}>`);
  const end = xml.indexOf(`</${name}>`, start);
  if (start < 0 || end < 0) return "";
  const inner = xml.slice(start + name.length + 2, end).trim();
  return inner.startsWith("<![CDATA[") && inner.endsWith("]]>") ? inner.slice(9, -3) : inner;
};
const strip = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** @type {import("@rocky/connector-sdk").Connector<{ url: string }, { seen: string[] }>} */
const rss = {
  id: "rss",
  displayName: "RSS feed",
  permissions: "Reads one public feed; never writes",
  configSchema: z.object({ url: z.url() }),
  secrets: [],
  defaultIntervalMin: 60,

  // Yield batches of normalized documents. The core persists each batch, then stores `cursor`.
  async *sync(ctx, cursor) {
    const xml = await (await ctx.http.fetch(ctx.config.url)).text();
    const seen = new Set(cursor?.seen ?? []);
    const documents = [];
    for (const [, item] of xml.matchAll(ITEM)) {
      const link = tag(item, "link");
      const id = tag(item, "guid") || link;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const published = Date.parse(tag(item, "pubDate")) || Date.now();
      documents.push({
        externalId: id,
        sourceType: "html",
        title: strip(tag(item, "title")) || link,
        uri: link,
        createdAt: published,
        updatedAt: published,
        mime: "text/html",
        // One unit per item; its anchor is what a citation opens.
        body: {
          kind: "text",
          units: [{ anchor: { kind: "text" }, text: strip(tag(item, "description")) }],
        },
      });
    }
    yield { documents, cursor: { seen: [...seen].slice(-500) } };
  },

  async health(ctx) {
    const res = await ctx.http.fetch(ctx.config.url);
    return res.ok
      ? { status: "ok", message: "Feed reachable" }
      : { status: "error", message: `Feed returned ${res.status}` };
  },
};

export default rss;
