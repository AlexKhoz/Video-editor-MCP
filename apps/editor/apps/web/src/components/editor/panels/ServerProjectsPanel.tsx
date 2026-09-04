import React, { useCallback, useEffect, useState } from "react";

import { refreshRegistry } from "../../../services/component-library-clips";
import { saveMediaBlob } from "../../../services/media-storage";
import {
  fetchServerMedia,
  listServerProjects,
  loadServerProject,
  saveServerProject,
  type ProjectSummary,
} from "../../../services/server-storage";
import { toast } from "../../../stores/notification-store";
import { useProjectStore } from "../../../stores/project-store";

/**
 * Server-side project list (Stage 8).
 *
 * The server is the source of truth: saving writes the whole project JSON to
 * render-service, and opening fetches it back plus the media bytes, so a project opens on
 * a browser that has never seen it. OpenReel's IndexedDB autosave stays underneath as a
 * local safety net.
 *
 * No authentication: every project here is visible and writable to anyone who can reach
 * the service, and concurrent edits are last-save-wins.
 */
export const ServerProjectsPanel: React.FC = () => {
  const project = useProjectStore((state) => state.project);
  const loadProject = useProjectStore((state) => state.loadProject);
  const getFullProject = useProjectStore((state) => state.getFullProject);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setProjects(await listServerProjects());
    } catch (err) {
      setProjects(null);
      setError(err instanceof Error ? err.message : "Could not reach the server");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    setBusy("Saving…");
    setError(null);
    try {
      // getFullProject() merges in text/shape/SVG/sticker clips, which live in the
      // engines rather than the store (see Stage 1 notes).
      const full = getFullProject();
      await saveServerProject(full);
      toast.success("Project saved to the server", full.name);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      toast.error("Could not save to the server", message);
    } finally {
      setBusy(null);
    }
  }, [getFullProject, refresh]);

  const handleOpen = useCallback(
    async (summary: ProjectSummary) => {
      setBusy(`Opening ${summary.name}…`);
      setError(null);
      try {
        const record = await loadServerProject(summary.id);
        const incoming = record.project;

        // Media bytes are not in the JSON. Pull each item from the server and attach the
        // blob, so the project works on a browser with an empty local cache.
        const items = await Promise.all(
          (incoming.mediaLibrary?.items ?? []).map(async (item) => {
            // A JSON round-trip leaves `blob` as `{}`, so test for a real Blob.
            if (item.blob instanceof Blob) return item;
            const blob = await fetchServerMedia(item.id);
            if (!blob) return { ...item, isPlaceholder: true };
            try {
              await saveMediaBlob(incoming.id, item.id, blob, item.metadata);
            } catch {
              // Local cache write is best-effort; the in-memory blob is what matters.
            }
            return { ...item, blob, isPlaceholder: false };
          }),
        );

        const missing = items.filter((item) => item.isPlaceholder).length;
        loadProject({ ...incoming, mediaLibrary: { items } });
        await refreshRegistry();

        toast.success(
          `Opened ${record.name}`,
          missing > 0
            ? `${items.length - missing}/${items.length} media files restored — ${missing} missing on the server.`
            : `${items.length} media file${items.length === 1 ? "" : "s"} restored from the server.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        toast.error("Could not open the project", message);
      } finally {
        setBusy(null);
      }
    },
    [loadProject],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <p className="pt-2 pb-3 text-[12px] leading-snug text-fg-muted">
        Projects stored on the server, available from any browser. No sign-in: everyone
        sees the same list, and the last save wins.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          aria-label="Save project to server"
          disabled={busy !== null}
          onClick={() => void handleSave()}
          className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold ${
            busy ? "bg-bg-2 text-fg-muted" : "bg-accent text-white"
          }`}
        >
          {busy === "Saving…" ? "Saving…" : "Save to server"}
        </button>
        <button
          type="button"
          aria-label="Refresh server project list"
          disabled={busy !== null}
          onClick={() => void refresh()}
          className="rounded-lg border border-border/70 px-3 py-2 text-[12px] font-medium text-fg-muted"
        >
          Refresh
        </button>
      </div>

      <p className="mt-2 text-[11px] text-fg-muted">
        Current project: <span className="text-fg">{project.name}</span>
      </p>

      {error && (
        <p className="mt-3 break-words text-[11px] text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 border-t border-border/70 pt-3">
        {projects === null && !error && (
          <p className="text-[12px] text-fg-muted">Loading…</p>
        )}
        {projects?.length === 0 && (
          <p className="text-[12px] text-fg-muted">
            Nothing saved yet. Press “Save to server”.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {projects?.map((summary) => (
            <li key={summary.id}>
              <button
                type="button"
                aria-label={`Open server project ${summary.name}`}
                disabled={busy !== null}
                onClick={() => void handleOpen(summary)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  summary.id === project.id
                    ? "border-accent bg-selected"
                    : "border-border/70 bg-bg-2"
                }`}
              >
                <span className="block text-[13px] font-semibold text-fg">
                  {summary.name}
                </span>
                <span className="mt-0.5 block text-[11px] text-fg-muted">
                  updated {new Date(summary.updatedAt).toLocaleString()}
                  {summary.id === project.id ? " · open" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {busy && busy !== "Saving…" && (
        <p className="mt-3 text-[11px] text-fg-muted">{busy}</p>
      )}
    </div>
  );
};

export default ServerProjectsPanel;
