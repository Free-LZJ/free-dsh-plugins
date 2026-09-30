/**
 * The flat-name view of the agent-import settings section.
 *
 * The section keeps its two per-tool option objects nested — `codex.home`,
 * `claudeCode.configPath` — while the shared staged form model addresses one
 * flat section member per control: it reads `value[field]`, tests the user
 * layer with `Object.hasOwn(user, field)`, and writes `{ path: [field] }`.
 *
 * This view re-keys the section by the dotted names the fields declare, and
 * expands those names back into path segments on the way out. It carries the
 * Host's status, writability, and revision through untouched, so the model's
 * save stays fenced at the revision its drafts were staged from.
 */

import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/** One leaf of a settings layer, and whether the layer carries it at all. */
interface Leaf {
  /** Whether the layer has this member, as opposed to having it as undefined. */
  readonly present: boolean
  /** The member's value. */
  readonly value: unknown
}

/**
 * View one path-addressed settings section under flat dotted names.
 * @param scope - the Host's form for the row's namespace.
 * @param names - the fields the card addresses, each a section path joined with '.'.
 * @returns the same form, keyed by those names.
 */
export function flatScope<T>(
  scope: SettingsFormScope<T>,
  names: readonly string[],
): SettingsFormScope<Record<string, unknown>> {
  return {
    getSnapshot: () => {
      const snapshot = scope.getSnapshot()
      return {
        status: snapshot.status,
        writable: snapshot.writable,
        revision: snapshot.revision,
        value: flatten(snapshot.value, names),
        base: flatten(snapshot.base, names),
        user: flatten(snapshot.user, names),
      }
    },
    subscribe: listener => scope.subscribe(listener),
    mutate: (ops, expectedRevision) => scope.mutate(ops.map(expand), expectedRevision),
  }
}

/**
 * Project one settings layer onto the flat names.
 * @param layer - the value, base, or user layer the Host serves.
 * @param names - the flat names the card addresses.
 * @returns one member per name the layer carries.
 */
function flatten(layer: unknown, names: readonly string[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const name of names) {
    const leaf = leafAt(layer, name.split('.'))
    if (leaf.present) flat[name] = leaf.value
  }
  return flat
}

/**
 * Read one dotted name out of a layer.
 * @param layer - the layer to read.
 * @param path - the name's path segments.
 * @returns the leaf, and whether the layer carries it.
 */
function leafAt(layer: unknown, path: readonly string[]): Leaf {
  let current = layer
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined }
    }
    current = member(current, segment)
  }
  return { present: true, value: current }
}

/**
 * Read one member of an object whose presence its caller proved.
 * @param source - the object to read.
 * @param key - the member name.
 * @returns the member's value.
 */
function member(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key]
}

/**
 * Rewrite one write of a flat field name onto the section path it stands for:
 * the shared form writes exactly one name per op, and a name carrying dots is
 * that many path segments.
 * @param op - the op the form wrote.
 * @returns the same op, addressed by path segments.
 */
function expand(op: SettingsFormPathOp): SettingsFormPathOp {
  const path = op.path.join('.').split('.')
  return op.op === 'set' ? { op: 'set', path, value: op.value } : { op: 'unset', path }
}
