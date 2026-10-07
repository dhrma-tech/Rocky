import {
  type ArchiveFormatName,
  ArchiveFormatSchema,
  type ArchiveImportResult,
} from "@rocky/contracts";
import { openRuntime, resolveDataDir } from "@rocky/core";
import { daemonClient } from "./commands.ts";

export function formatImport(r: ArchiveImportResult): string {
  const lines = [
    `${r.archive} (${r.format}): ${r.messages} messages in ${r.documents} documents; ` +
      `${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged` +
      (r.skipped ? `, ${r.skipped} skipped` : ""),
    ...r.warnings.map((w) => `warning: ${w}`),
  ];
  return lines.join("\n");
}

/**
 * Imports a chat export (WhatsApp, Discord, Instagram, X, LinkedIn). The running daemon does it
 * when it is up, so its job runner embeds the result; otherwise it runs here and embeds inline.
 */
export async function archiveImportCommand(
  abs: string,
  opts: { dataDir?: string | undefined; format?: string },
): Promise<number> {
  let format: ArchiveFormatName | undefined;
  if (opts.format) {
    const f = ArchiveFormatSchema.safeParse(opts.format);
    if (!f.success) {
      console.error(`--format must be one of: ${ArchiveFormatSchema.options.join(", ")}`);
      return 1;
    }
    format = f.data;
  }
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const client = await daemonClient(dir);
  if (client) {
    const res = await fetch(`${client.base}/api/v1/imports/archive/path`, {
      method: "POST",
      headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: abs, ...(format ? { format } : {}) }),
    });
    const body = (await res.json()) as ArchiveImportResult & { error?: string };
    if (!res.ok) {
      console.error(body.error ?? `daemon returned ${res.status}`);
      return 1;
    }
    console.log(formatImport(body));
    console.log("The daemon is embedding it in the background.");
    return 0;
  }
  const { importArchive } = await import("@rocky/daemon");
  const { readArchive, UnrecognizedArchive } = await import("@rocky/importers");
  const rt = await openRuntime({ dataDir: dir });
  try {
    const r = await importArchive(rt, await readArchive(abs), format);
    console.log(formatImport(r));
    const n = await rt.drainJobs((m) => console.error(m));
    if (n) console.log(`embedded ${n} document(s)`);
    return 0;
  } catch (err) {
    if (err instanceof UnrecognizedArchive) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    rt.close();
  }
}
