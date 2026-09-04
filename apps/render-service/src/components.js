import fs from "node:fs/promises";
import path from "node:path";

import { componentsDir } from "./config.js";

/**
 * The component catalogue is just the meta.json files in
 * packages/component-library/components/. Read fresh each time so a new component
 * appears without restarting the service.
 */
export async function listComponents() {
  const entries = await fs.readdir(componentsDir, { withFileTypes: true });
  const components = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(componentsDir, entry.name, "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      if (meta.id !== entry.name) {
        throw new Error(`meta.json id "${meta.id}" does not match directory "${entry.name}"`);
      }
      components.push(meta);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`Invalid component metadata at ${metaPath}: ${error.message}`);
    }
  }

  return components.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getComponent(componentId) {
  const components = await listComponents();
  return components.find((component) => component.id === componentId) ?? null;
}

/**
 * Validates and normalises props against a component's param schema. Unknown keys are
 * dropped, missing keys take their default, numbers are range-checked. Param `type`
 * values follow OpenReel's MotionVariable vocabulary:
 * text | number | color | boolean | media.
 */
export function validateProps(meta, rawProps = {}) {
  const errors = [];
  const props = {};

  if (rawProps === null || typeof rawProps !== "object" || Array.isArray(rawProps)) {
    return { props: {}, errors: ["props must be a JSON object"] };
  }

  for (const param of meta.params ?? []) {
    const supplied = rawProps[param.key];
    if (supplied === undefined || supplied === null) {
      props[param.key] = param.default;
      continue;
    }

    switch (param.type) {
      case "text":
      case "media": {
        if (typeof supplied !== "string") {
          errors.push(`"${param.key}" must be a string`);
          break;
        }
        props[param.key] = supplied;
        break;
      }
      case "color": {
        if (typeof supplied !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(supplied)) {
          errors.push(`"${param.key}" must be a hex colour such as #ffcc00`);
          break;
        }
        props[param.key] = supplied;
        break;
      }
      case "number": {
        const value = Number(supplied);
        if (!Number.isFinite(value)) {
          errors.push(`"${param.key}" must be a number`);
          break;
        }
        if (param.min !== undefined && value < param.min) {
          errors.push(`"${param.key}" must be >= ${param.min}`);
          break;
        }
        if (param.max !== undefined && value > param.max) {
          errors.push(`"${param.key}" must be <= ${param.max}`);
          break;
        }
        props[param.key] = value;
        break;
      }
      case "boolean": {
        if (typeof supplied !== "boolean") {
          errors.push(`"${param.key}" must be a boolean`);
          break;
        }
        props[param.key] = supplied;
        break;
      }
      default: {
        errors.push(`"${param.key}" has unsupported type "${param.type}"`);
      }
    }
  }

  const known = new Set((meta.params ?? []).map((param) => param.key));
  const ignored = Object.keys(rawProps).filter((key) => !known.has(key));

  return { props, errors, ignored };
}

/** Duration of the rendered clip in seconds, per the component's declared duration param. */
export function resolveDuration(meta, props) {
  const key = meta.durationParam;
  if (!key) return null;
  const value = Number(props[key]);
  return Number.isFinite(value) ? value : null;
}
