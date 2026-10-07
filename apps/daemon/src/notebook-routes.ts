import {
  NotebookCreateSchema,
  NotebookUpdateSchema,
  QuizAnswerSchema,
  QuizCreateSchema,
  RatingSchema,
  ScopeRulesSchema,
} from "@rocky/contracts";
import {
  addSource,
  ankiCsv,
  answerQuestion,
  countdown,
  createNotebook,
  createQuiz,
  currentSlotNotebook,
  deleteCard,
  deleteNotebook,
  enqueueStudy,
  getNotebook,
  latestMindMap,
  latestStudyGuide,
  listCards,
  listNotebooks,
  nextQuestion,
  notebookSources,
  previewScope,
  type Runtime,
  removeSource,
  reviewCard,
  reviewQueue,
  type StudyTask,
  sourcePack,
  studyGuideMarkdown,
  updateCard,
  updateNotebook,
  workload,
} from "@rocky/core";
import type { Hono } from "hono";
import { z } from "zod";

type Body = <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) => Promise<T>;

const CardPatch = z
  .object({
    front: z.string().min(1).max(2000),
    back: z.string().min(1).max(4000),
    suspended: z.boolean(),
  })
  .partial()
  .strict();
const StudyTaskSchema = z.enum(["cards", "summaries", "guide", "mindmap"]);
const safeName = (s: string) =>
  s
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-") || "notebook";

/** Notebooks and Study screens (ui.md, Phase 5). Long model work is queued as jobs. */
export function registerNotebookRoutes(
  api: Hono,
  { rt, poke, body }: { rt: Runtime; poke?: (() => void) | undefined; body: Body },
): void {
  const study = { db: rt.db, router: rt.router, embedder: rt.embedder };
  const queue = (id: string, task: StudyTask) => {
    getNotebook(rt.db, id);
    const jobId = enqueueStudy(rt.db, id, task);
    poke?.();
    return { jobId };
  };

  api.get("/notebooks", (c) => c.json({ notebooks: listNotebooks(rt.db) }));
  api.post("/notebooks", async (c) =>
    c.json(createNotebook(rt.db, await body(c, NotebookCreateSchema)), 201),
  );
  api.get("/notebooks/current-slot", (c) => c.json({ notebook: currentSlotNotebook(rt.db) }));
  api.post("/notebooks/scope/preview", async (c) =>
    c.json(previewScope(rt.db, await body(c, ScopeRulesSchema))),
  );
  api.get("/notebooks/:id", (c) => c.json(getNotebook(rt.db, c.req.param("id"))));
  api.patch("/notebooks/:id", async (c) =>
    c.json(updateNotebook(rt.db, c.req.param("id"), await body(c, NotebookUpdateSchema))),
  );
  api.delete("/notebooks/:id", (c) =>
    c.json(
      deleteNotebook(rt.db, rt.paths.blobs, c.req.param("id"), c.req.query("withSources") === "1"),
    ),
  );
  api.get("/notebooks/:id/sources", (c) =>
    c.json({ sources: notebookSources(rt.db, c.req.param("id")) }),
  );
  api.post("/notebooks/:id/sources/:docId", (c) =>
    c.json(addSource(rt.db, c.req.param("id"), c.req.param("docId"))),
  );
  api.delete("/notebooks/:id/sources/:docId", (c) =>
    c.json(removeSource(rt.db, c.req.param("id"), c.req.param("docId"))),
  );

  // --- study ---
  api.post("/notebooks/:id/jobs/:task", (c) => {
    const task = StudyTaskSchema.safeParse(c.req.param("task"));
    if (!task.success) return c.json({ error: "unknown task", code: "BAD_REQUEST" }, 400);
    return c.json(queue(c.req.param("id"), task.data), 202);
  });
  api.get("/notebooks/:id/guide", (c) => {
    getNotebook(rt.db, c.req.param("id"));
    return c.json({ guide: latestStudyGuide(rt.db, c.req.param("id")) });
  });
  api.get("/notebooks/:id/mindmap", (c) => {
    getNotebook(rt.db, c.req.param("id"));
    return c.json({ mindmap: latestMindMap(rt.db, c.req.param("id")) });
  });
  api.get("/notebooks/:id/countdown", (c) => c.json(countdown(rt.db, c.req.param("id"))));
  api.get("/notebooks/:id/workload", async (c) =>
    c.json({ items: await workload(rt.db, c.req.param("id"), rt.embedder) }),
  );
  // Drive source pack: this week of the course as a Google Doc, queued for approval (notebooks.md).
  api.post("/notebooks/:id/source-pack", (c) => {
    const draft = sourcePack(rt.db, c.req.param("id"));
    if (!rt.registry.get("gdrive.sourcePackWrite"))
      return c.json({ error: "Connect Google Drive first.", code: "NOT_CONFIGURED" }, 400);
    if (draft.documents === 0)
      return c.json({ error: "Nothing was added to this notebook this week.", code: "EMPTY" }, 400);
    return c.json(
      rt.actions.propose({
        type: "gdrive.sourcePackWrite",
        payload: draft.payload,
        origin: "user_turn",
        citations: draft.citations,
        allowedTypes: ["gdrive.sourcePackWrite"],
      }),
      201,
    );
  });
  api.get("/notebooks/:id/cards", (c) => c.json({ cards: listCards(rt.db, c.req.param("id")) }));
  api.get("/notebooks/:id/export", (c) => {
    const id = c.req.param("id");
    const nb = getNotebook(rt.db, id);
    const format = c.req.query("format");
    if (format === "anki")
      return c.body(ankiCsv(rt.db, id), 200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName(nb.name)}-anki.txt"`,
      });
    if (format === "md") {
      const guide = latestStudyGuide(rt.db, id);
      if (!guide) return c.json({ error: "Build the study guide first.", code: "NOT_FOUND" }, 404);
      return c.body(studyGuideMarkdown(guide), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName(nb.name)}-study-guide.md"`,
      });
    }
    return c.json({ error: "format must be anki or md", code: "BAD_REQUEST" }, 400);
  });

  api.get("/study/review", (c) =>
    c.json(reviewQueue(rt.db, { notebookId: c.req.query("notebook") || undefined })),
  );
  api.post("/cards/:id/review", async (c) => {
    const { rating } = await body(c, z.object({ rating: RatingSchema }).strict());
    return c.json(reviewCard(rt.db, c.req.param("id"), rating));
  });
  api.patch("/cards/:id", async (c) =>
    c.json(updateCard(rt.db, c.req.param("id"), await body(c, CardPatch))),
  );
  api.delete("/cards/:id", (c) =>
    deleteCard(rt.db, c.req.param("id"))
      ? c.json({ deleted: true })
      : c.json({ error: "card not found", code: "NOT_FOUND" }, 404),
  );

  api.post("/quizzes", async (c) =>
    c.json(createQuiz(rt.db, await body(c, QuizCreateSchema)), 201),
  );
  api.post("/quizzes/:id/next", async (c) => c.json(await nextQuestion(study, c.req.param("id"))));
  api.post("/quizzes/:id/answer", async (c) => {
    const { questionId, answer } = await body(c, QuizAnswerSchema);
    return c.json(await answerQuestion(study, c.req.param("id"), questionId, answer));
  });
}
