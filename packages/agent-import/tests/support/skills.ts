/** Skill fixtures: one catalog row, its offerings, and one mutation outcome. */

import type {
  SkillCandidate, SkillCatalog, SkillImportOutcome, SkillReport,
} from '../../src/client/agent-import-skills.ts'

/**
 * One offering, as the Host half serializes it.
 * @param overrides - the fields this fixture replaces.
 * @returns the offering, from Codex and winning unless told otherwise.
 */
export function skillCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    source: 'codex',
    label: 'Codex',
    scope: 'user',
    path: '/home/u/.codex/skills/demo',
    file: '/home/u/.codex/skills/demo/SKILL.md',
    realPath: '/home/u/.codex/skills/demo',
    linked: false,
    winner: true,
    ...overrides,
  }
}

/**
 * One catalog row, as the Host half serializes it.
 * @param overrides - the fields this fixture replaces.
 * @returns the row, offered by Codex alone and not yet imported.
 */
export function skillReport(overrides: Partial<SkillReport> = {}): SkillReport {
  return {
    name: 'demo',
    description: 'Demo skill.',
    candidates: [skillCandidate()],
    state: 'available',
    conflict: false,
    ...overrides,
  }
}

/**
 * One mutation outcome, as the Host half serializes it.
 * @param overrides - the fields this fixture replaces.
 * @returns the outcome, having changed nothing, unless told otherwise.
 */
export function skillOutcome(overrides: Partial<SkillImportOutcome> = {}): SkillImportOutcome {
  return { imported: [], removed: [], skipped: [], notes: [], ...overrides }
}

/**
 * One catalog read, as the Host half serializes it.
 * @param overrides - the fields this fixture replaces.
 * @returns the catalog, naming one available skill and no scan notes.
 */
export function skillCatalog(overrides: Partial<SkillCatalog> = {}): SkillCatalog {
  return { skills: [skillReport()], notes: [], ...overrides }
}
