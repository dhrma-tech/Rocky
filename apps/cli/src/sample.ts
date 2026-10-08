import {
  loadSampleWorkspace,
  openRuntime,
  removeSampleWorkspace,
  resolveDataDir,
  SAMPLE_TOUR,
  sampleLoaded,
} from "@rocky/core";

/**
 * `rocky sample load | remove | tour` (roadmap A9): a small fictional workspace for a first cited
 * answer before importing anything. It is kept apart from your sources and removed in one step.
 */
export async function sampleCommand(
  action: string,
  opts: { dataDir?: string | undefined },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    if (action === "load") {
      const r = await loadSampleWorkspace(rt.db, rt.paths.blobs);
      const n = await rt.drainJobs();
      console.log(
        `Loaded ${r.documents} sample documents${n ? ` and embedded ${n}` : ""}. Try: rocky ask "${SAMPLE_TOUR[0]?.question}"`,
      );
      return 0;
    }
    if (action === "remove") {
      const r = removeSampleWorkspace(rt.db, rt.paths.blobs);
      console.log(`Removed ${r.documents} sample documents. Your own sources were not touched.`);
      return 0;
    }
    if (action === "tour") {
      if (!sampleLoaded(rt.db)) console.log("The sample isn't loaded yet: rocky sample load");
      for (const t of SAMPLE_TOUR) console.log(`- ${t.question}\n  A good answer: ${t.expect}`);
      return 0;
    }
    console.error(`Unknown action "${action}". Use: load | remove | tour`);
    return 1;
  } finally {
    rt.close();
  }
}
