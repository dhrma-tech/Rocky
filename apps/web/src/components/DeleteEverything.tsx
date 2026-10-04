import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api.ts";
import { Button } from "./ui.tsx";

/**
 * "Delete everything" (DESIGN §5.6 Settings → Privacy): a destructive confirm that names exactly
 * what is deleted and needs the word DELETE typed. Uses <dialog> for focus trapping and Esc.
 */
export function DeleteEverything() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const del = useMutation({ mutationFn: api.deleteEverything });

  if (del.isSuccess)
    return (
      <p role="status" className="text-sm text-secondary">
        Rocky is deleting everything and will stop. Close this tab; start the daemon again to begin
        fresh.
      </p>
    );

  return (
    <div className="space-y-2">
      <Button variant="danger" onClick={() => dialog.current?.showModal()}>
        <Trash2 size={16} aria-hidden /> Delete everything
      </Button>
      <p className="text-xs text-tertiary">
        Removes all memory and keys on this machine. This can't be undone.
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="delete-all-title"
        onClose={() => setTyped("")}
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl bg-overlay p-6 text-primary shadow-raised-lg backdrop:bg-scrim"
      >
        <h2 id="delete-all-title" className="text-lg font-semibold">
          Delete everything?
        </h2>
        <p className="mt-2 text-sm text-secondary">This permanently removes:</p>
        <ul className="mt-1 list-disc pl-5 text-sm text-secondary">
          <li>every imported document, its index and stored files</li>
          <li>the action queue and the audit log</li>
          <li>database backups and eval databases</li>
          <li>API keys and the sign-in token in the OS keychain</li>
        </ul>
        <p className="mt-2 text-sm text-secondary">
          Settings and downloaded models stay. The daemon stops afterwards.
        </p>
        <label htmlFor="delete-confirm" className="mt-4 block text-sm font-medium">
          Type DELETE to confirm
        </label>
        <input
          id="delete-confirm"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-md border border-border-strong bg-page px-3 font-mono text-sm"
        />
        {del.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {del.error.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={typed !== "DELETE" || del.isPending}
            onClick={() => del.mutate(undefined, { onSuccess: () => dialog.current?.close() })}
          >
            Delete everything
          </Button>
        </div>
      </dialog>
    </div>
  );
}
