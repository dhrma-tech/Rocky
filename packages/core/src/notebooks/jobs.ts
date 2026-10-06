import { ulid } from "ulid";
import { enqueue, type Job, setJobProgress } from "../jobs/queue.ts";
import type { JobHandler } from "../jobs/runner.ts";
import type { Db } from "../store/db.ts";
import { generateCards } from "./flashcards.ts";
import { buildMindMap, buildStudyGuide, summarizeDocuments } from "./guide.ts";
import type { StudyDeps } from "./sources.ts";

/**
 * Long study work runs as heavy jobs (serialized with whisper and meeting extraction, since they
 * all compete for the CPU when models run locally). The UI follows them via GET /jobs/:id/events.
 */
export const STUDY_JOB = "study";
export type StudyTask = "cards" | "summaries" | "guide" | "mindmap";

export function enqueueStudy(db: Db, notebookId: string, task: StudyTask): string {
  const pending = db
    .prepare(
      `select id from jobs where type = ? and status in ('queued', 'running')
       and json_extract(payload, '$.notebookId') = ? and json_extract(payload, '$.task') = ?`,
    )
    .get(STUDY_JOB, notebookId, task) as { id: string } | undefined;
  if (pending) return pending.id;
  return enqueue(db, STUDY_JOB, { notebookId, task }, { heavy: true, priority: 1, maxAttempts: 1 });
}

export function studyJobHandler(deps: StudyDeps): JobHandler {
  return async (job: Job) => {
    const { notebookId, task } = job.payload as { notebookId: string; task: StudyTask };
    const progress = (note: string) => (done: number, total: number) =>
      setJobProgress(deps.db, job.id, total ? done / total : 1, `${note} ${done}/${total}`);
    if (task === "cards")
      await generateCards(deps, notebookId, { onProgress: progress("cards from chunk") });
    else if (task === "summaries")
      await summarizeDocuments(deps, notebookId, { onProgress: progress("summarizing") });
    else if (task === "guide") {
      // The guide groups by topics from document summaries, so make sure they exist first.
      await summarizeDocuments(deps, notebookId, { onProgress: progress("summarizing") });
      await buildStudyGuide(deps, notebookId, { onProgress: progress("topic") });
    } else if (task === "mindmap") {
      setJobProgress(deps.db, job.id, 0.1, "building the concept map");
      const map = await buildMindMap(deps, notebookId);
      deps.db
        .prepare(
          "delete from summaries where notebook_id = ? and level = 'notebook' and scope_key = 'mindmap'",
        )
        .run(notebookId);
      deps.db
        .prepare(
          "insert into summaries (id, level, scope_key, notebook_id, text, model, created_at) values (?, 'notebook', 'mindmap', ?, ?, 'mindmap', ?)",
        )
        .run(ulid(), notebookId, JSON.stringify(map), Date.now());
    }
    setJobProgress(deps.db, job.id, 1, "done");
  };
}

export function latestMindMap(db: Db, notebookId: string): unknown {
  const r = db
    .prepare(
      "select text from summaries where notebook_id = ? and level = 'notebook' and scope_key = 'mindmap' order by created_at desc limit 1",
    )
    .get(notebookId) as { text: string } | undefined;
  return r ? JSON.parse(r.text) : null;
}
