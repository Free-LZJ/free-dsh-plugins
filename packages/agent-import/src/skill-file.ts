/**
 * Reader for the `SKILL.md` files Codex and Claude Code serve.
 *
 * Both tools use the same instruction-file layout dsh does: a `---` YAML
 * frontmatter block with `name` and `description`, followed by the instruction
 * body. This reader applies dsh's skill-name grammar so an imported skill can
 * address the model catalog, and reports why a file is unusable instead of
 * dropping it silently; the provider turns those reasons into log warnings.
 *
 * @module @deepseek-ai/dsh-agent-import/skill-file
 */

import { readFile } from 'node:fs/promises'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Frontmatter fields an imported skill carries into the dsh catalog. */
export interface ParsedSkill {
  /** Kebab-case skill name from frontmatter, already validated. */
  readonly name: string
  /** Routing description from frontmatter. */
  readonly description: string
  /** Optional extra routing guidance from frontmatter. */
  readonly whenToUse?: string
  /** Whether the model catalog includes this skill. */
  readonly modelInvocable: boolean
  /** Whether the human-facing command catalog includes this skill. */
  readonly userInvocable: boolean
  /** Instruction body after frontmatter removal. */
  readonly content: string
}

/**
 * Parse one foreign skill file.
 * @param path - absolute path of the `SKILL.md` file.
 * @returns the parsed skill, or the reason this path is not a usable skill file.
 */
export async function readSkillFile(path: string): Promise<ParsedSkill | string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'file no longer exists' : `unreadable (${String(error)})`
  }
  const frontmatter = splitFrontmatter(raw)
  if (frontmatter === undefined) return 'missing a `---` YAML frontmatter block'
  const name = nonEmptyString(frontmatter.data['name'])
  if (name === undefined) return 'frontmatter requires a non-empty "name"'
  if (!isSkillName(name)) return `invalid skill name "${name}"`
  const description = nonEmptyString(frontmatter.data['description'])
  if (description === undefined) return 'frontmatter requires a non-empty "description"'
  const disableModel = readFlag(frontmatter.data['disable-model-invocation'])
  if (disableModel === 'invalid') return '"disable-model-invocation" must be a boolean'
  const userInvocable = readFlag(frontmatter.data['user-invocable'])
  if (userInvocable === 'invalid') return '"user-invocable" must be a boolean'
  const whenToUse = nonEmptyString(frontmatter.data['whenToUse'])
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
    content: frontmatter.body.trim(),
  }
}

/** Separate the YAML frontmatter object from the instruction body. */
function splitFrontmatter(raw: string): { data: Readonly<Record<string, unknown>>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const closing = findClosingDelimiter(raw, firstLineEnd + 1)
  if (closing === undefined) return undefined
  let data: unknown
  try {
    data = parseYaml(raw.slice(firstLineEnd + 1, closing.start))
  } catch {
    // An unparseable frontmatter block makes this one file unusable; sibling skills are unaffected.
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return { data: data as Readonly<Record<string, unknown>>, body: raw.slice(closing.bodyStart) }
}

/** Locate the closing `---` line and the body offset that follows it. */
function findClosingDelimiter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  for (;;) {
    const lineEnd = raw.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? raw.length : lineEnd
    if (raw.slice(lineStart, end).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: lineEnd === -1 ? raw.length : lineEnd + 1 }
    }
    if (lineEnd === -1) return undefined
    lineStart = lineEnd + 1
  }
}

/** Read a non-empty string field, treating every other value as absent. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read an optional boolean field, accepting the spellings the foreign tools write. */
function readFlag(value: unknown): boolean | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  }
  return 'invalid'
}
