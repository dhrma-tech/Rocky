import { z } from "zod";
import { CitationSchema, SourceTypeSchema } from "./memory.ts";
import { PathInfoSchema } from "./router.ts";

/** Spec: docs/specs/notebooks.md. A notebook is a saved scope over the one memory. */

export const NotebookKindSchema = z.enum(["course", "project", "research"]);
export type NotebookKind = z.infer<typeof NotebookKindSchema>;

export const ScopeRulesSchema = z
  .object({
    connectorIds: z.array(z.string()).max(50),
    /** Recursive: files in these folders or any subfolder. */
    driveFolderIds: z.array(z.string()).max(50),
    /** With descendants (sub-pages). Data-source ids also work for database rows. */
    notionPageIds: z.array(z.string()).max(50),
    /** Local folders (absolute paths), recursive: a project's folder (docs/DECISIONS.md D-047). */
    localFolders: z.array(z.string().min(1).max(1000)).max(20),
    sourceTypes: z.array(SourceTypeSchema).max(20),
    /** Case-insensitive title contains, e.g. a course code "CS201". */
    titleMatches: z.array(z.string().min(2).max(100)).max(20),
    dateFrom: z.number().int(),
    dateTo: z.number().int(),
  })
  .partial()
  .strict();
export type ScopeRules = z.infer<typeof ScopeRulesSchema>;

export const NotebookScopeSchema = z
  .object({
    /** Manual adds; manual removals are kept as `excludedIds`. */
    documentIds: z.array(z.string()).max(10_000).default([]),
    excludedIds: z.array(z.string()).max(10_000).default([]),
    rules: ScopeRulesSchema.default({}),
  })
  .strict();
export type NotebookScope = z.infer<typeof NotebookScopeSchema>;

export const ScheduleSlotSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday. */
    day: z.number().int().min(0).max(6),
    /** "09:00" local time. */
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();
export type ScheduleSlot = z.infer<typeof ScheduleSlotSchema>;

export const ExamDateSchema = z
  .object({ title: z.string().min(1).max(200), at: z.number().int() })
  .strict();
export type ExamDate = z.infer<typeof ExamDateSchema>;

const NotebookFields = {
  name: z.string().trim().min(1).max(200),
  kind: NotebookKindSchema,
  term: z.string().max(100).nullable(),
  instructor: z.string().max(200).nullable(),
  schedule: z.array(ScheduleSlotSchema).max(30),
  examDates: z.array(ExamDateSchema).max(30),
  examTag: z.string().max(50),
  localOnly: z.boolean(),
  /** Record lectures into this notebook during its schedule slots. */
  captureDefault: z.boolean(),
  scope: NotebookScopeSchema,
};

export const NotebookCreateSchema = z
  .object({
    ...NotebookFields,
    kind: NotebookKindSchema.default("course"),
    term: NotebookFields.term.default(null),
    instructor: NotebookFields.instructor.default(null),
    schedule: NotebookFields.schedule.default([]),
    examDates: NotebookFields.examDates.default([]),
    examTag: NotebookFields.examTag.default("exam"),
    localOnly: z.boolean().default(false),
    captureDefault: z.boolean().default(false),
    scope: NotebookScopeSchema.default({ documentIds: [], excludedIds: [], rules: {} }),
  })
  .strict();
export type NotebookCreate = z.input<typeof NotebookCreateSchema>;

export const NotebookUpdateSchema = z.object(NotebookFields).partial().strict();
export type NotebookUpdate = z.infer<typeof NotebookUpdateSchema>;

export const NotebookSchema = z.object({
  id: z.string(),
  ...NotebookFields,
  createdAt: z.number().int(),
  sourceCount: z.number().int(),
  cardCount: z.number().int(),
  dueCount: z.number().int(),
  /** Share of cards with an interval ≥ 21 days (the progress ring). */
  mastery: z.number().min(0).max(1),
  nextExam: ExamDateSchema.nullable(),
});
export type Notebook = z.infer<typeof NotebookSchema>;

export const NotebookSourceSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  sourceType: z.string(),
  connectorId: z.string().nullable(),
  addedBy: z.enum(["rule", "manual"]),
  updatedAt: z.number().int().nullable(),
  uri: z.string().nullable(),
});
export type NotebookSource = z.infer<typeof NotebookSourceSchema>;

// --- study ---

export const RatingSchema = z.enum(["again", "hard", "good", "easy"]);
export type Rating = z.infer<typeof RatingSchema>;

export const CardSchema = z.object({
  id: z.string(),
  notebookId: z.string(),
  front: z.string(),
  back: z.string(),
  topic: z.string().nullable(),
  sourceChunkId: z.string().nullable(),
  ef: z.number(),
  intervalDays: z.number().int(),
  repetitions: z.number().int(),
  dueAt: z.number().int().nullable(),
  suspended: z.boolean(),
  isNew: z.boolean(),
  citation: CitationSchema.nullable(),
});
export type Card = z.infer<typeof CardSchema>;

export const ReviewQueueSchema = z.object({
  cards: z.array(CardSchema),
  dueToday: z.number().int(),
  newToday: z.number().int(),
  newLimit: z.number().int(),
});
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;

/** A mathjs computation the model asks for; the daemon evaluates it (the model never writes the number). */
export const ComputationSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,20}$/i),
  expr: z.string().min(1).max(500),
  purpose: z.string().max(200),
});
export type Computation = z.infer<typeof ComputationSchema>;

export const ComputedValueSchema = z.object({
  id: z.string(),
  expr: z.string(),
  purpose: z.string(),
  value: z.string().nullable(),
  /** Why it was not computed (unsupported operation, timeout, error). */
  notComputed: z.string().nullable(),
});
export type ComputedValue = z.infer<typeof ComputedValueSchema>;

export const DifficultySchema = z.enum(["easy", "medium", "hard"]);

export const QuizCreateSchema = z
  .object({
    notebookId: z.string(),
    topics: z.array(z.string().min(1).max(100)).max(10).default([]),
    difficulty: DifficultySchema.default("medium"),
    /** Route generation and grading to the strongest API model (needs a key). */
    examGrade: z.boolean().default(false),
    multipleChoice: z.boolean().default(false),
  })
  .strict();
export type QuizCreate = z.input<typeof QuizCreateSchema>;

/** What the student sees: never the reference answer. */
export const QuizQuestionSchema = z.object({
  id: z.string(),
  quizId: z.string(),
  question: z.string(),
  options: z.array(z.string()).nullable(),
  topic: z.string(),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizAnswerSchema = z
  .object({ questionId: z.string(), answer: z.string().min(1).max(4000) })
  .strict();

export const QuizGradeSchema = z.object({
  questionId: z.string(),
  grade: z.number().min(0).max(1),
  /** Feedback with computed values substituted. */
  feedback: z.string(),
  referenceAnswer: z.string(),
  citations: z.array(CitationSchema),
  computations: z.array(ComputedValueSchema),
  path: PathInfoSchema.nullable(),
});
export type QuizGrade = z.infer<typeof QuizGradeSchema>;

export const TopicWeaknessSchema = z.object({
  topic: z.string(),
  weakness: z.number().min(0).max(1),
  attempts: z.number().int(),
  cards: z.number().int(),
});

export const CountdownSchema = z.object({
  exam: ExamDateSchema.nullable(),
  daysLeft: z.number().int().nullable(),
  topics: z.array(TopicWeaknessSchema),
  plan: z.object({ cards: z.number().int(), quizTopics: z.array(z.string()) }),
});
export type Countdown = z.infer<typeof CountdownSchema>;

export const WorkloadItemSchema = z.object({
  kind: z.enum(["exam", "commitment", "event"]),
  title: z.string(),
  due: z.number().int(),
  documentId: z.string().nullable(),
  related: z.array(z.object({ documentId: z.string(), title: z.string(), score: z.number() })),
});
export type WorkloadItem = z.infer<typeof WorkloadItemSchema>;

export const StudyGuideSchema = z.object({
  notebookId: z.string(),
  title: z.string(),
  sections: z.array(
    z.object({
      topic: z.string(),
      sentences: z.array(z.object({ text: z.string(), citations: z.array(CitationSchema) })),
    }),
  ),
  createdAt: z.number().int(),
});
export type StudyGuide = z.infer<typeof StudyGuideSchema>;

export const MindMapSchema = z.object({
  nodes: z.array(
    z.object({ id: z.string(), label: z.string(), citations: z.array(CitationSchema) }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().nullable() })),
});
export type MindMap = z.infer<typeof MindMapSchema>;

// --- model output schemas (nullable rather than optional: small local models do better) ---

export const FlashcardGenSchema = z.object({
  cards: z.array(
    z.object({
      front: z.string().min(1),
      back: z.string().min(1),
      /** Exact words from the chunk that support the back. */
      quote: z.string().min(1),
      chunkRef: z.string(),
      topic: z.string(),
    }),
  ),
});
export type FlashcardGen = z.infer<typeof FlashcardGenSchema>;

export const QuizGenSchema = z.object({
  question: z.string().min(1),
  /** Multiple-choice options, or null for free text. */
  options: z.array(z.string()).nullable(),
  referenceAnswer: z.string().min(1),
  quote: z.string().min(1),
  chunkRef: z.string(),
  topic: z.string(),
  computations: z.array(ComputationSchema),
});
export type QuizGen = z.infer<typeof QuizGenSchema>;

export const QuizGradeOutSchema = z.object({
  grade: z.number().min(0).max(1),
  /** May contain {{calc:id}} placeholders; never the computed numbers themselves. */
  feedback: z.string().min(1),
  citations: z.array(z.object({ chunkRef: z.string(), quote: z.string() })),
  computations: z.array(ComputationSchema),
});
export type QuizGradeOut = z.infer<typeof QuizGradeOutSchema>;

export const DocSummaryOutSchema = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()).max(12),
});
export type DocSummaryOut = z.infer<typeof DocSummaryOutSchema>;

export const MindMapOutSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().min(1).max(80),
        chunkRefs: z.array(z.string()),
      }),
    )
    .max(60),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().nullable() })),
});
export type MindMapOut = z.infer<typeof MindMapOutSchema>;
