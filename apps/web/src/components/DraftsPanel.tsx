import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Mail, PenLine, Search, X } from "lucide-react";
import { useState } from "react";
import { api, assistant } from "../api.ts";
import { SafeText } from "./SafeText.tsx";
import { Button, cls, IconButton } from "./ui.tsx";

const inputCls = "min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm";

/**
 * Drafts panel (DESIGN screen 7, Phase 6): the user's instruction, an optional thread, then a
 * Gmail draft proposal lands in the queue below. Nothing is sent: approval creates a Gmail draft.
 */
export function DraftsPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<{ id: string; title: string } | null>(null);
  const [status, setStatus] = useState("");
  const style = useQuery({ queryKey: ["style"], queryFn: assistant.style, enabled: open });
  const threads = useQuery({
    queryKey: ["thread-search", q.trim()],
    queryFn: () => api.previewScope({ titleMatches: [q.trim()], sourceTypes: ["email"] }),
    enabled: open && q.trim().length >= 2 && !thread,
  });
  const draft = useMutation({
    mutationFn: () =>
      assistant.draft(
        { instruction: instruction.trim(), ...(thread ? { threadId: thread.id } : {}) },
        (e) => typeof e.text === "string" && setStatus(e.text),
      ),
    onSuccess: () => {
      setInstruction("");
      setThread(null);
      setQ("");
      void qc.invalidateQueries({ queryKey: ["actions"] });
    },
    onSettled: () => setStatus(""),
  });
  const learn = useMutation({ mutationFn: assistant.refreshStyle });

  if (!open)
    return (
      <Button onClick={() => setOpen(true)}>
        <PenLine size={16} aria-hidden /> Draft an email
      </Button>
    );
  return (
    <section
      aria-label="Draft an email"
      className="space-y-3 rounded-lg bg-raised p-4 shadow-raised-sm"
    >
      <div className="flex items-center gap-2">
        <Mail size={18} aria-hidden className="text-accent-strong" />
        <h2 className="mr-auto text-base font-semibold">Draft an email</h2>
        <IconButton label="Close" onClick={() => setOpen(false)}>
          <X size={18} aria-hidden />
        </IconButton>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        What should it say?
        <textarea
          value={instruction}
          rows={3}
          maxLength={2000}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Reply to Prof. Rao asking for an extension to Friday"
          className="rounded-md border border-border-strong bg-page p-3 text-sm font-normal"
        />
      </label>
      {thread ? (
        <p className="flex items-center gap-2 text-sm">
          Replying in <span className="font-medium">{thread.title}</span>
          <IconButton
            label="Choose another thread"
            onClick={() => setThread(null)}
            className="size-8"
          >
            <X size={14} aria-hidden />
          </IconButton>
        </p>
      ) : (
        <div>
          <label className="relative block">
            <span className="sr-only">Find the thread to reply to</span>
            <Search size={16} aria-hidden className="absolute left-3 top-3.5 text-tertiary" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Thread to reply to (optional; found from the request otherwise)"
              className={cls(inputCls, "pl-9")}
            />
          </label>
          {threads.data && (
            <ul className="mt-1 flex flex-col">
              {threads.data.sample.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setThread(t)}
                    className="min-h-10 w-full truncate rounded-md px-3 text-left text-sm hover:bg-layer-faint"
                  >
                    {t.title}
                  </button>
                </li>
              ))}
              {threads.data.sample.length === 0 && (
                <li className="px-3 text-xs text-secondary">No threads match.</li>
              )}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-secondary">
        {style.data?.profile ? (
          <>
            Written in your style: <SafeText text={style.data.profile.descriptor} />
          </>
        ) : (
          <>
            No style profile yet.{" "}
            <button
              type="button"
              className="underline"
              disabled={learn.isPending}
              onClick={() => learn.mutate()}
            >
              Learn it from my sent mail
            </button>{" "}
            (runs on this computer when it can).
          </>
        )}
        {learn.isSuccess && " Learning; it is used from the next draft."}
        {learn.error && <span className="text-danger"> {learn.error.message}</span>}
      </p>
      {draft.error && (
        <p role="alert" className="text-sm text-danger">
          {draft.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={instruction.trim().length < 3 || draft.isPending}
          onClick={() => draft.mutate()}
        >
          {draft.isPending && (
            <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
          )}
          Write draft
        </Button>
        <span aria-live="polite" className="text-xs text-secondary">
          {draft.isPending
            ? `${status || "Starting"}…`
            : draft.isSuccess
              ? "Added to the queue below."
              : ""}
        </span>
        <span className="ml-auto text-xs text-tertiary">
          Approving saves a Gmail draft. Rocky never sends mail.
        </span>
      </div>
    </section>
  );
}

/** A Gmail draft payload as an email, instead of JSON. */
export function EmailPreview({ payload }: { payload: unknown }) {
  const p = payload as { to?: string[]; cc?: string[]; subject?: string; body?: string };
  return (
    <div className="rounded-md bg-sunken p-3 text-sm">
      <p>
        <span className="text-secondary">To </span>
        {p.to?.join(", ")}
      </p>
      {p.cc && p.cc.length > 0 && (
        <p>
          <span className="text-secondary">Cc </span>
          {p.cc.join(", ")}
        </p>
      )}
      <p className="font-medium">{p.subject}</p>
      <p className="mt-2 whitespace-pre-wrap">
        <SafeText text={p.body ?? ""} />
      </p>
    </div>
  );
}
