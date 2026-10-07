import type { ArchiveImportResult, ArchiveImportRow } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, uploadArchive } from "../api.ts";
import { Button } from "../components/ui.tsx";
import { relativeTime } from "./ConnectorsPage.tsx";

const FORMATS: Record<ArchiveImportRow["format"], { name: string; how: string }> = {
  whatsapp: { name: "WhatsApp", how: "Chat › More › Export chat (the .txt or .zip)" },
  discord: { name: "Discord", how: "Settings › Data & Privacy › Request data (the package .zip)" },
  instagram: { name: "Instagram", how: "Accounts Center › Download your information, JSON format" },
  x: { name: "X", how: "Settings › Your account › Download an archive (the .zip)" },
  linkedin: { name: "LinkedIn", how: "Settings › Data privacy › Get a copy of your data" },
};

function ImportRow({ row }: { row: ArchiveImportRow }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteArchiveImport(row.format, row.archive),
    onSettled: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["imports"] });
    },
  });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.archive || FORMATS[row.format].name}</p>
        <p className="text-xs text-secondary">
          {FORMATS[row.format].name} · {row.messages} messages in {row.documents} documents ·
          imported {relativeTime(row.importedAt)}
        </p>
      </div>
      {confirming ? (
        <div className="flex gap-2">
          <Button variant="ghost" className="min-h-9" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button
            variant="danger"
            className="min-h-9"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete {row.documents} documents
          </Button>
        </div>
      ) : (
        <Button variant="ghost" className="min-h-9" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
      {remove.error && (
        <p role="alert" className="w-full text-sm text-danger">
          {remove.error.message}
        </p>
      )}
    </li>
  );
}

/** Import panel (PLAN Phase 8): chat exports become searchable, cited documents. */
export function ImportPanel() {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ArchiveImportResult | null>(null);
  const list = useQuery({ queryKey: ["imports"], queryFn: api.archiveImports });
  const upload = useMutation({
    mutationFn: (file: File) => uploadArchive(file, setProgress),
    onMutate: () => setResult(null),
    onSuccess: setResult,
    onSettled: () => {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: ["imports"] });
    },
  });
  const imports = list.data?.imports ?? [];

  return (
    <section aria-labelledby="import-title" className="mt-16">
      <h2 id="import-title" className="text-lg font-semibold">
        Import an export
      </h2>
      <p className="mt-2 max-w-prose text-sm text-secondary">
        Chat history from apps Rocky can't connect to. The file is read on this machine; photos and
        videos inside it are skipped. Each message can be cited.
      </p>
      <ul className="mt-4 grid gap-1 text-xs text-secondary sm:grid-cols-2">
        {Object.values(FORMATS).map((f) => (
          <li key={f.name}>
            <span className="font-semibold text-primary">{f.name}</span>: {f.how}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept=".zip,.txt,.js,.csv,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <Button disabled={upload.isPending} onClick={() => input.current?.click()}>
          <Upload size={16} aria-hidden />
          {upload.isPending
            ? progress !== null && progress < 1
              ? `Uploading ${Math.round(progress * 100)}%`
              : "Reading…"
            : "Choose a file"}
        </Button>
        {result && (
          <p role="status" className="text-sm text-secondary">
            {FORMATS[result.format].name}: {result.messages} messages, {result.added} new and{" "}
            {result.updated} updated documents
            {result.unchanged ? `, ${result.unchanged} already imported` : ""}.
          </p>
        )}
      </div>
      {result?.warnings.map((w) => (
        <p key={w} className="mt-1 text-xs text-warning">
          {w}
        </p>
      ))}
      {(upload.error ?? list.error) && (
        <p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-danger">
          {(upload.error ?? list.error)?.message}
        </p>
      )}
      {imports.length > 0 && (
        <ul className="mt-6 divide-y divide-border-base rounded-lg bg-raised px-4 shadow-raised-sm">
          {imports.map((r) => (
            <ImportRow key={`${r.format}:${r.archive}`} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}
