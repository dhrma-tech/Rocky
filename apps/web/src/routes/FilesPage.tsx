import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FolderOpen } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { api, files, type ReadFileView } from "../api.ts";
import {
  Button,
  type Column,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Segmented,
  Skeleton,
  Table,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

type Action = "read" | "created" | "changed" | "deleted";
const NEVER: Record<Exclude<Action, "read">, string> = {
  created: "Rocky has never created a file on this computer outside its own data folder.",
  changed: "Rocky has never changed one of your files. It only reads them.",
  deleted:
    "Rocky has never deleted one of your files. Forgetting a file only removes Rocky's copy.",
};
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const size = (n: number | null) =>
  n === null
    ? "—"
    : n < 1024
      ? `${n} B`
      : n < 1024 ** 2
        ? `${(n / 1024).toFixed(0)} KB`
        : `${(n / 1024 ** 2).toFixed(1)} MB`;

/**
 * Files (UI spec 14): every file Rocky read, so nothing happens to your files without a trace.
 * Rocky only reads; it writes nothing outside its data folder, and the Created, Changed and
 * Deleted filters say so plainly (D-059).
 */
export function FilesPage() {
  const [action, setAction] = useState<Action>("read");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [open, setOpen] = useState<ReadFileView | null>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const list = useQuery({
    queryKey: ["files", q],
    queryFn: () => files.list(q || undefined),
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.files ?? [];

  const columns: Column<ReadFileView>[] = [
    {
      key: "name",
      title: "Name",
      sort: (f) => f.name.toLowerCase(),
      render: (f) => (
        <button
          type="button"
          className="rk-files__name"
          onClick={() => setOpen(f)}
          aria-label={`Preview ${f.name}`}
        >
          {f.name}
        </button>
      ),
    },
    {
      key: "action",
      title: "Action",
      render: (f) =>
        f.exists ? "Read" : <span className="rk-muted">Read · no longer on disk</span>,
    },
    {
      key: "time",
      title: "Read",
      sort: (f) => f.readAt,
      render: (f) => <span className="rk-nums">{when(f.readAt)}</span>,
    },
    {
      key: "path",
      title: "Path",
      render: (f) => <span className="rk-files__path rk-small rk-muted">{f.path}</span>,
    },
    {
      key: "size",
      title: "Size",
      sort: (f) => f.size ?? -1,
      render: (f) => <span className="rk-nums">{size(f.size)}</span>,
    },
  ];

  let body: React.ReactNode;
  if (action !== "read")
    body = (
      <p className="rk-files__never">
        {NEVER[action]}{" "}
        {settings.data && (
          <>
            Rocky's own files live in <code className="rk-mono">{settings.data.dataDir}</code>.
          </>
        )}
      </p>
    );
  else if (list.isLoading) body = <Skeleton rows={8} height={52} label="Loading files" />;
  else if (list.error)
    body = (
      <ErrorState
        title="Couldn't read the file list."
        happened={list.error.message}
        rockyDid="Nothing was changed."
        fix={
          <Button variant="primary" onClick={() => void list.refetch()}>
            Retry
          </Button>
        }
      />
    );
  else if (!rows.length && !q)
    body = (
      <EmptyState headline="Rocky hasn't touched any files.">
        Add a folder in Projects or Settings and the files Rocky reads are listed here.
      </EmptyState>
    );
  else if (!rows.length) body = <p className="rk-muted">No file matches “{q}”.</p>;
  else
    body = (
      <Table
        caption="Files Rocky read"
        columns={columns}
        rows={rows}
        rowKey={(f) => f.documentId}
        initialSort={{ key: "time", dir: "desc" }}
        rowProps={(f) => (f.exists ? {} : { className: "rk-files__gone" })}
      />
    );

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">Files</h1>
        <span className="rk-small rk-muted">
          Rocky reads your files. It never creates, changes or deletes them.
        </span>
      </header>
      <div className="rk-history__filters">
        <Segmented
          label="What happened"
          value={action}
          onChange={setAction}
          options={[
            { value: "read", label: "Read" },
            { value: "created", label: "Created" },
            { value: "changed", label: "Changed" },
            { value: "deleted", label: "Deleted" },
          ]}
        />
        {action === "read" && (
          <Input
            label="Search names and paths"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {body}
      <Preview file={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Preview({ file, onClose }: { file: ReadFileView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const text = useQuery({
    queryKey: ["file-preview", file?.documentId],
    queryFn: () => files.preview(file?.documentId as string),
    enabled: file !== null,
  });
  const reveal = useMutation({ mutationFn: () => files.reveal(file?.documentId as string) });
  const forget = useMutation({
    mutationFn: () => files.forget(file?.documentId as string),
    onSuccess: () => {
      setConfirm(false);
      onClose();
      void qc.invalidateQueries({ queryKey: ["files"] });
      toast({ text: `Rocky forgot ${file?.name}. The file is still on disk.` });
    },
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file?.path ?? "");
      toast({ text: "Path copied." });
    } catch {
      toast({ text: "Couldn't copy. Your browser blocked the clipboard." });
    }
  };
  return (
    <Drawer open={file !== null} onClose={onClose} title={file?.name ?? "File"}>
      {file && (
        <div className="rk-files__preview">
          <p className="rk-small rk-muted rk-files__path" style={{ margin: 0 }}>
            {file.path}
          </p>
          {!file.exists && (
            <p className="rk-small" style={{ margin: 0 }}>
              <strong>No longer on disk.</strong> Rocky still has the text it read.
            </p>
          )}
          <div className="rk-files__actions">
            <Button
              variant="primary"
              disabled={!file.exists}
              loading={reveal.isPending && "Opening…"}
              icon={<FolderOpen size={16} strokeWidth={1.5} aria-hidden />}
              onClick={() => reveal.mutate()}
            >
              Open in folder
            </Button>
            <Button
              icon={<Copy size={16} strokeWidth={1.5} aria-hidden />}
              onClick={() => void copy()}
            >
              Copy path
            </Button>
            <Button variant="tertiary" onClick={() => setConfirm(true)}>
              Forget this file
            </Button>
          </div>
          {reveal.error && (
            <p role="alert" className="rk-small" style={{ margin: 0 }}>
              {reveal.error.message}
            </p>
          )}
          <h3 className="rk-h3" style={{ margin: 0 }}>
            What Rocky read
          </h3>
          {text.isLoading && <Skeleton rows={1} height={200} label="Loading the preview" />}
          {text.error && (
            <p role="alert" className="rk-small">
              {text.error.message}
            </p>
          )}
          {text.data && (
            <>
              <pre className="rk-files__text">{text.data.text}</pre>
              {text.data.truncated && (
                <p className="rk-small rk-muted" style={{ margin: 0 }}>
                  Showing the first part of {file.textChars.toLocaleString()} characters.
                </p>
              )}
            </>
          )}
        </div>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Forget this file?"
        actions={
          <>
            <Button variant="tertiary" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={forget.isPending && "Forgetting…"}
              onClick={() => forget.mutate()}
            >
              Forget
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Rocky removes its copy of the text and any citations to it. The file on disk stays as it
          is. If the folder is still watched, Rocky reads it again when it changes.
        </p>
        {forget.error && (
          <p role="alert" className="rk-small">
            {forget.error.message}
          </p>
        )}
      </Modal>
    </Drawer>
  );
}
