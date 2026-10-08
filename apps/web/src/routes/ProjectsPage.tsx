import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { type ProjectView, projects } from "../api.ts";
import {
  Banner,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Skeleton,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

const ago = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "Rocky reads files in ~/launch and asks before changing anything." (the live boundary line) */
const boundary = (p: ProjectView) =>
  `Rocky reads files in ${p.folder} and asks before changing anything.`;

/** Projects (UI spec 12): one piece of work, a name and a folder (D-017, D-047). */
export function ProjectsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const [creating, setCreating] = useState(false);
  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">Projects</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New project
        </Button>
      </header>
      {list.isLoading && <Skeleton rows={3} height={112} label="Loading projects" />}
      {list.error && (
        <ErrorState
          title="Couldn't read your projects."
          happened={list.error.message}
          rockyDid="Nothing was changed."
          fix={<Button onClick={() => void list.refetch()}>Retry</Button>}
        />
      )}
      {list.data && list.data.projects.length === 0 && (
        <EmptyState
          headline="Pick a folder to start."
          action={<Button onClick={() => setCreating(true)}>New project</Button>}
        >
          A project is a folder Rocky may read. Rocky can't see a folder until you pick it.
        </EmptyState>
      )}
      <ul className="rk-list" style={{ gap: "var(--space-3)" }}>
        {list.data?.projects.map((p) => (
          <li key={p.id}>
            <Card as="article" aria-labelledby={`p-${p.id}`}>
              <div className="rk-task__head">
                <h2 id={`p-${p.id}`} className="rk-h3 rk-task__title">
                  <Link to="/projects/$id" params={{ id: p.id }}>
                    {p.name}
                  </Link>
                </h2>
                <span className="rk-small rk-muted">{p.documentCount} documents</span>
              </div>
              <p
                className="rk-small rk-muted"
                style={{ margin: "var(--space-1) 0 0", overflowWrap: "anywhere" }}
              >
                {p.folderExists ? p.folder : `This folder moved or was deleted: ${p.folder}`} ·
                since {ago(p.createdAt)}
              </p>
            </Card>
          </li>
        ))}
      </ul>
      <Drawer open={creating} onClose={() => setCreating(false)} title="New project">
        <NewProject
          onDone={(p) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ["projects"] });
            toast({ text: `${p.name} created. Rocky is reading its folder.` });
          }}
        />
      </Drawer>
    </div>
  );
}

function NewProject({ onDone }: { onDone: (p: ProjectView) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const create = useMutation({
    mutationFn: () => projects.create(name, folder),
    onSuccess: onDone,
  });
  return (
    <form
      style={{ display: "grid", gap: "var(--space-4)" }}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        label="Folder"
        help="The full path on this computer, e.g. E:\\Work\\Launch. A browser can't open a folder picker for a local path."
        value={folder}
        error={create.error?.message ?? null}
        onChange={(e) => setFolder(e.target.value)}
      />
      {folder.trim() && (
        <Card>
          <h3 className="rk-h3">What Rocky will be allowed to do</h3>
          <p style={{ margin: 0 }}>
            Rocky reads files in {folder.trim()} and asks before changing anything. Nothing outside
            this folder joins the project.
          </p>
        </Card>
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim() || !folder.trim()}
          loading={create.isPending ? "Creating…" : false}
        >
          Create project
        </Button>
      </div>
    </form>
  );
}

export function ProjectPage() {
  const { id } = useParams({ from: "/projects/$id" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const p = useQuery({ queryKey: ["project", id], queryFn: () => projects.get(id) });
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [archiving, setArchiving] = useState(false);
  const update = useMutation({
    mutationFn: (patch: { name?: string; folder?: string }) => projects.update(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast({ text: "Saved." });
    },
  });
  const archive = useMutation({
    mutationFn: () => projects.archive(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void navigate({ to: "/projects" });
    },
  });
  if (p.isLoading)
    return (
      <div className="rk-page">
        <Skeleton rows={3} height={80} label="Loading the project" />
      </div>
    );
  if (!p.data)
    return (
      <div className="rk-page">
        <ErrorState
          title="This project isn't here."
          happened={p.error?.message ?? "It may have been archived."}
          fix={
            <Link to="/projects" className="rk-button rk-button--secondary">
              Back to Projects
            </Link>
          }
        />
      </div>
    );
  const proj = p.data;
  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">{proj.name}</h1>
        {proj.notebookId && (
          <Link
            to="/notebooks/$id"
            params={{ id: proj.notebookId }}
            className="rk-button rk-button--primary"
          >
            Ask about this project
          </Link>
        )}
      </header>
      {!proj.folderExists && (
        <Banner tone="warning" title="This folder moved or was deleted.">
          Locate it below, or archive the project. Its history stays either way.
        </Banner>
      )}
      <Card>
        <h2 className="rk-h3">Boundaries</h2>
        <p style={{ margin: 0 }}>{boundary(proj)}</p>
        <p className="rk-small rk-muted" style={{ margin: "var(--space-2) 0 0" }}>
          {proj.documentCount} documents from this folder so far. Project rules arrive in a later
          release; global rules in Settings apply.
        </p>
      </Card>
      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          marginTop: "var(--space-6)",
          maxWidth: 560,
        }}
      >
        <form
          style={{ display: "grid", gap: "var(--space-2)" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) update.mutate({ name });
          }}
        >
          <Input
            label="Rename"
            placeholder={proj.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <Button type="submit" disabled={!name.trim()}>
              Rename
            </Button>
          </div>
        </form>
        <form
          style={{ display: "grid", gap: "var(--space-2)" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (folder.trim()) update.mutate({ folder });
          }}
        >
          <Input
            label={proj.folderExists ? "Change folder" : "Locate the folder"}
            placeholder={proj.folder}
            value={folder}
            error={update.error?.message ?? null}
            onChange={(e) => setFolder(e.target.value)}
          />
          <div>
            <Button type="submit" disabled={!folder.trim()}>
              {proj.folderExists ? "Change folder" : "Locate"}
            </Button>
          </div>
        </form>
        <div>
          <Button variant="tertiary" onClick={() => setArchiving(true)}>
            Archive project…
          </Button>
        </div>
      </div>
      <Modal
        open={archiving}
        onClose={() => setArchiving(false)}
        title={`Archive ${proj.name}?`}
        actions={
          <>
            <Button variant="tertiary" onClick={() => setArchiving(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => archive.mutate()}>
              Archive
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Its documents, notebook and history stay. It leaves the Projects list.
        </p>
      </Modal>
    </div>
  );
}
