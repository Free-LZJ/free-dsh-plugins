/**
 * The script action, in the kernel.
 *
 * Two rules come with it, and they are the reason this action is written once here
 * rather than per connector:
 *
 * 1. **Arguments are an array, never a shell string.** Nothing in an argument is ever
 *    parsed as shell syntax, so a subject containing `; rm -rf /` has nothing to run.
 * 2. **Only header-shaped values are substituted.** The projection decides what is
 *    available; a connector that refuses to put the body in it makes injection via
 *    the body impossible by construction. Script arguments appear in the process
 *    list, and a body is untrusted content.
 *
 * @module @free-lzj/dsh-decision/actions/script
 */

import { fillTemplate, type ActionResult, type TemplateValues } from '../registry.ts'

/** Output kept in the run record; the full output has nowhere to live. */
const OUTPUT_LIMIT = 500

/** What a command run needs to report. */
export interface SpawnResult {
  /** Exit code; 
ull when the process died by a signal rather than exiting. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** The subprocess capability, as far as this action needs it. */
export interface SubprocessPort {
  spawn(request: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
  }): Promise<SpawnResult>
}

/** One script action's configuration. */
export interface ScriptSpec {
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
}

/** What one script run needs. */
export interface ScriptContext {
  readonly templateValues: TemplateValues
  readonly subprocess?: SubprocessPort
}

/**
 * Fill placeholders in one argument list.
 * @param args - the configured arguments.
 * @param values - the projection.
 * @returns the filled arguments, still as separate strings.
 */
export function fillArgs(args: readonly string[], values: TemplateValues): readonly string[] {
  return args.map(arg => fillTemplate(arg, values))
}

/**
 * Run the script action.
 * @param spec - the command, its arguments, and where to run it.
 * @param context - the projection and the subprocess port.
 * @returns whether it ran, with the first line of its output.
 */
export async function runScript(spec: ScriptSpec, context: ScriptContext): Promise<ActionResult> {
  const runner = context.subprocess
  if (runner === undefined) return { ok: false, message: '未挂载子进程能力，无法执行脚本' }
  if (spec.command === undefined || spec.command === '') return { ok: false, message: '这条 script 动作没有写 command' }
  const args = fillArgs(spec.args ?? [], context.templateValues)
  try {
    const result = await runner.spawn({
      command: spec.command,
      args,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    })
    if (result.code !== 0) {
      const why = firstLine(result.stderr) || firstLine(result.stdout)
      return { ok: false, message: `脚本退出码 ${String(result.code)}：${why}` }
    }
    const summary = firstLine(result.stdout)
    return { ok: true, detail: summary === '' ? `${spec.command} 执行完成` : `${spec.command}：${summary}` }
  } catch (error: unknown) {
    return { ok: false, message: `脚本执行失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The first non-empty line, truncated.
 *
 * A run record holds one sentence; a command that prints a hundred lines must still
 * leave a readable trace. The ellipsis says it was cut — silently shortening would
 * read as the whole output.
 * @param text - one stream's output.
 * @returns the line to keep, or an empty string.
 */
export function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length <= OUTPUT_LIMIT ? line : `${line.slice(0, OUTPUT_LIMIT)}…`
}
