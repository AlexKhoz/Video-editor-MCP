import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useProjectStore } from "../../../stores/project-store";
import { toast } from "../../../stores/notification-store";

/**
 * Component Library panel.
 *
 * Lists the animated components served by render-service (`GET /components`), renders a
 * form from each component's param schema, and on Generate queues a render, polls it to
 * completion, then hands the resulting file to the project store's existing
 * `importMedia()` so it lands in the media library like any other import.
 *
 * Components are rendered on a chroma-green backdrop rather than with an alpha channel:
 * OpenReel's decoder drops alpha (see NOTES.md), so transparency is achieved by keying
 * the green out with the clip's existing Chroma Key controls.
 */

const RENDER_SERVICE_URL =
  (import.meta.env.VITE_RENDER_SERVICE_URL as string | undefined) ?? "http://127.0.0.1:3001";

/** Matches OpenReel's own chroma-key default (keyColor r:0 g:1 b:0). */
const CHROMA_BACKGROUND = "#00ff00";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 10 * 60_000;

type ParamType = "text" | "number" | "color" | "boolean" | "media";

interface ComponentParam {
  key: string;
  label?: string;
  type: ParamType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
}

interface ComponentMeta {
  id: string;
  name: string;
  description?: string;
  durationParam?: string;
  params: ComponentParam[];
}

type PropValue = string | number | boolean;

function defaultsFor(meta: ComponentMeta): Record<string, PropValue> {
  const values: Record<string, PropValue> = {};
  for (const param of meta.params ?? []) {
    values[param.key] = param.default as PropValue;
  }
  return values;
}

export const ComponentLibraryPanel: React.FC = () => {
  const importMedia = useProjectStore((state) => state.importMedia);

  const [components, setComponents] = useState<ComponentMeta[] | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, PropValue>>({});
  const [phase, setPhase] = useState<"idle" | "queued" | "rendering" | "importing">("idle");
  const [progress, setProgress] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  const selected = useMemo(
    () => components?.find((component) => component.id === selectedId) ?? null,
    [components, selectedId],
  );

  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      const response = await fetch(`${RENDER_SERVICE_URL}/components`);
      if (!response.ok) throw new Error(`render-service returned ${response.status}`);
      const body = (await response.json()) as { components: ComponentMeta[] };
      setComponents(body.components);
    } catch (error) {
      setComponents(null);
      setCatalogueError(
        error instanceof Error ? error.message : "Could not reach the render service",
      );
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  const selectComponent = useCallback((meta: ComponentMeta) => {
    setSelectedId(meta.id);
    setValues(defaultsFor(meta));
    setLastError(null);
  }, []);

  const setValue = useCallback((key: string, value: PropValue) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const busy = phase !== "idle";

  const handleGenerate = useCallback(async () => {
    if (!selected) return;
    setLastError(null);
    setProgress(0);
    setPhase("queued");

    try {
      const enqueue = await fetch(`${RENDER_SERVICE_URL}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          componentId: selected.id,
          props: values,
          background: CHROMA_BACKGROUND,
        }),
      });

      if (!enqueue.ok) {
        const body = await enqueue.json().catch(() => ({}));
        throw new Error(
          body.details?.join("; ") || body.error || `render-service returned ${enqueue.status}`,
        );
      }

      const { jobId } = (await enqueue.json()) as { jobId: string };
      setPhase("rendering");

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let fileUrl: string | null = null;

      while (Date.now() < deadline) {
        const poll = await fetch(`${RENDER_SERVICE_URL}/render/${jobId}`);
        if (!poll.ok) throw new Error(`Job lookup failed with ${poll.status}`);
        const job = (await poll.json()) as {
          status: string;
          progress?: number;
          url?: string;
          error?: string;
        };

        setProgress(Number(job.progress ?? 0));

        if (job.status === "done") {
          fileUrl = job.url ?? null;
          break;
        }
        if (job.status === "failed") {
          throw new Error(job.error || "Render failed");
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (!fileUrl) throw new Error("Render did not finish in time");

      setPhase("importing");
      const download = await fetch(`${RENDER_SERVICE_URL}${fileUrl}`);
      if (!download.ok) throw new Error(`Could not download the render (${download.status})`);
      const blob = await download.blob();

      const label = String(values[selected.params[0]?.key] ?? selected.id)
        .slice(0, 24)
        .replace(/[^\w -]+/g, "")
        .trim();
      const fileName = `${selected.id}${label && label !== selected.id ? `-${label}` : ""}.webm`;
      const file = new File([blob], fileName, { type: "video/webm" });

      const result = await importMedia(file);
      if (!result.success) {
        throw new Error(result.error?.message ?? "Import failed");
      }

      toast.success(
        `${selected.name} added to media`,
        "Drop it on a track, then enable Chroma Key to remove the green background.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setLastError(message);
      toast.error("Could not generate component", message);
    } finally {
      setPhase("idle");
      setProgress(0);
    }
  }, [importMedia, selected, values]);

  if (catalogueError) {
    return (
      <div className="px-4 py-6 text-[13px] text-fg-muted">
        <p className="mb-2 font-semibold text-fg">Render service unavailable</p>
        <p className="mb-3 break-words">{catalogueError}</p>
        <p className="mb-3">
          Start it with <code className="text-fg">npm start</code> and{" "}
          <code className="text-fg">npm run worker</code> in{" "}
          <code className="text-fg">apps/render-service</code>, then retry.
        </p>
        <button
          type="button"
          onClick={() => void loadCatalogue()}
          className="rounded-lg bg-selected px-3 py-1.5 font-semibold text-accent"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!components) {
    return <div className="px-4 py-6 text-[13px] text-fg-muted">Loading components…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <p className="pt-2 pb-3 text-[12px] leading-snug text-fg-muted">
        Generated on a green background — enable Chroma Key on the clip to key it out.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {components.map((component) => {
          const isActive = component.id === selectedId;
          return (
            <button
              key={component.id}
              type="button"
              aria-label={`Select component ${component.name}`}
              aria-pressed={isActive}
              onClick={() => selectComponent(component)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                isActive ? "border-accent bg-selected" : "border-border/70 bg-bg-2"
              }`}
            >
              <span className="block text-[13px] font-semibold text-fg">{component.name}</span>
              {component.description && (
                <span className="mt-1 block text-[11px] leading-snug text-fg-muted">
                  {component.description}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mt-4 border-t border-border/70 pt-4">
          <div className="mb-3 text-[13px] font-semibold text-fg">{selected.name}</div>

          <div className="flex flex-col gap-3">
            {selected.params.map((param) => {
              const label = param.label ?? param.key;
              const value = values[param.key];
              const inputId = `component-param-${selected.id}-${param.key}`;

              return (
                <div key={param.key} className="flex flex-col gap-1">
                  <label htmlFor={inputId} className="text-[11px] font-medium text-fg-muted">
                    {label}
                  </label>

                  {param.type === "text" || param.type === "media" ? (
                    <input
                      id={inputId}
                      type="text"
                      value={String(value ?? "")}
                      onChange={(event) => setValue(param.key, event.target.value)}
                      className="rounded-md border border-border/70 bg-bg-2 px-2 py-1.5 text-[13px] text-fg"
                    />
                  ) : param.type === "color" ? (
                    <div className="flex items-center gap-2">
                      <input
                        id={inputId}
                        type="color"
                        value={String(value ?? "#ffffff")}
                        onChange={(event) => setValue(param.key, event.target.value)}
                        className="h-8 w-12 rounded-md border border-border/70 bg-bg-2"
                      />
                      <span className="text-[12px] tabular-nums text-fg-muted">
                        {String(value ?? "")}
                      </span>
                    </div>
                  ) : param.type === "number" ? (
                    <div className="flex items-center gap-2">
                      <input
                        id={inputId}
                        type="range"
                        min={param.min ?? 0}
                        max={param.max ?? 10}
                        step={param.step ?? 1}
                        value={Number(value ?? 0)}
                        onChange={(event) => setValue(param.key, Number(event.target.value))}
                        className="flex-1"
                      />
                      <span className="w-10 text-right text-[12px] tabular-nums text-fg">
                        {Number(value ?? 0)}
                      </span>
                    </div>
                  ) : (
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(event) => setValue(param.key, event.target.checked)}
                      className="h-4 w-4"
                    />
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            aria-label="Generate component"
            disabled={busy}
            onClick={() => void handleGenerate()}
            className={`mt-4 w-full rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${
              busy ? "bg-bg-2 text-fg-muted" : "bg-accent text-white"
            }`}
          >
            {phase === "idle" && "Generate"}
            {phase === "queued" && "Queued…"}
            {phase === "rendering" && `Rendering… ${progress}%`}
            {phase === "importing" && "Adding to media…"}
          </button>

          {lastError && (
            <p className="mt-2 break-words text-[11px] text-red-400" role="alert">
              {lastError}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ComponentLibraryPanel;
