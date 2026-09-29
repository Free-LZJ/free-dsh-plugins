/**
 * Value readers shared by the foreign configuration adapters.
 *
 * Codex TOML and Claude Code JSON both describe an MCP server with the same
 * scalar and array values, so both adapters read them through this module and
 * report an unusable declaration the same way.
 *
 * @module @deepseek-ai/dsh-agent-import/values
 */

/**
 * Read an array-of-strings value; `undefined` reports a present but unusable key.
 * @param value - candidate value read from a foreign configuration file.
 * @returns the string items, an empty list when the key is absent, or `undefined` when the key is present but unusable.
 */
export function stringList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return items
}

/**
 * Read a non-empty string value, treating every other value as absent.
 * @param value - candidate value read from a foreign configuration file.
 * @returns the string when it is non-empty, otherwise `undefined`.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
