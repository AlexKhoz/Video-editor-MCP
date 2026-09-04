/**
 * Props reach a project two ways, checked in this order:
 *
 *  1. a `props` query parameter on the page URL (URL-encoded JSON) — this is what the
 *     render harness uses, so one running dev server can render any prop combination;
 *  2. the `VITE_COMPONENT_PROPS` env var (JSON), inlined by Vite at transform time.
 *
 * Unknown keys are ignored and missing keys fall back to the component's defaults, so a
 * project always renders even with no props supplied (which is what `npm run dev` does).
 */
export function resolveProps<T extends Record<string, unknown>>(defaults: T): T {
  return mergeProps(defaults, readFromUrl() ?? readFromEnv());
}

function readFromUrl(): unknown {
  if (typeof location === "undefined") return null;
  const raw = new URLSearchParams(location.search).get("props");
  return raw ? parseJson(raw) : null;
}

function readFromEnv(): unknown {
  const raw = import.meta.env.VITE_COMPONENT_PROPS as string | undefined;
  return raw ? parseJson(raw) : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("[component-library] props are not valid JSON", error);
    return null;
  }
}

function mergeProps<T extends Record<string, unknown>>(defaults: T, supplied: unknown): T {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return defaults;
  }

  const source = supplied as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (source[key] !== undefined && source[key] !== null) {
      merged[key] = source[key];
    }
  }
  return merged as T;
}
