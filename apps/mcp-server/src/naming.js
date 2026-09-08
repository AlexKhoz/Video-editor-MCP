/**
 * Naming rules the MCP server enforces on what it creates.
 *
 * Lives in its own module because `index.js` builds and connects the stdio server as a side
 * effect of being imported, so a unit test cannot import the helper from there.
 */

/** The suffix every project created through this server carries. */
export const MCP_PROJECT_SUFFIX = "-MCP";

/**
 * Marks a project name as MCP-created.
 *
 * Enforced here rather than documented for the calling agent, because a convention that
 * depends on the agent remembering it is a convention that gets dropped — this session lost
 * the `-Rep` component suffix, a shared-assets request and a five-component deletion that
 * way. Server-side, the guarantee holds whatever the caller passes.
 *
 * An already-suffixed name is not doubled. The comparison is case-insensitive and the suffix
 * is normalised to its canonical casing, so the resulting names are uniform enough for a
 * case-sensitive filter over the project list.
 *
 * An empty or missing name still gets the suffix: project-kit would otherwise fall back to
 * "Untitled", and an unsuffixed project is exactly what this is meant to prevent.
 */
export function withMcpProjectSuffix(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  const base = trimmed === "" ? "Untitled" : trimmed;

  if (base.toLowerCase().endsWith(MCP_PROJECT_SUFFIX.toLowerCase())) {
    return base.slice(0, base.length - MCP_PROJECT_SUFFIX.length) + MCP_PROJECT_SUFFIX;
  }
  return base + MCP_PROJECT_SUFFIX;
}
