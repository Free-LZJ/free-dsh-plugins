/**
 * Defaults, and the one place untrusted input becomes a shape the plugin trusts.
 *
 * The panel posts JSON over HTTP and the settings drawer is a plain document, so
 * every field travels as `unknown` until it has been through here: a trigger that
 * names a mode the trigger does not implement, an account whose port is a string,
 * an action that would move 501 messages — all of them end as either a valid
 * value or a field name the route can answer with 400. Nothing in this file
 * throws, because a malformed request must not take the Host half down.
 *
 * @module @free-lzj/dsh-mail/config
 */

import { isAbsolute } from 'node:path'
import type {
  Config,
  DraftAccount,
  MailAccount,
  MailAction,
  MailProvider,
  SessionTriggerOptions,
  TriggerConfig,
  TriggerFilters,
  TriggerMode,
  TriggerRule,
} from './types.ts'

/** Bottom-of-the-barrel rescan interval, in seconds. */
export const DEFAULT_FALLBACK_SCAN_SECONDS = 300

/**
 * How many recent messages `/dsh-mail/state` carries.
 *
 * Size only matters on the pass that actually changes something and on the first
 * draw after a start: the panel hands back the revision it holds, so an unchanged
 * list costs a few dozen bytes however large this is. Anything older than this
 * window needs paging, not a bigger number.
 */
export const DEFAULT_MAX_LIST_MESSAGES = 300

/** Abort an IMAP command after this many seconds. */
export const DEFAULT_IMAP_TIMEOUT_SECONDS = 30

/** The loader row's defaults, shared by the Host half and the panel's settings drawer. */
export const DEFAULT_CONFIG: Config = {
  fallbackScanSeconds: DEFAULT_FALLBACK_SCAN_SECONDS,
  maxListMessages: DEFAULT_MAX_LIST_MESSAGES,
  imapTimeoutSeconds: DEFAULT_IMAP_TIMEOUT_SECONDS,
}

/** Modes a trigger may name. */
const TRIGGER_MODES = new Set<string>(['session', 'notify', 'panel'])

/** Providers the settings drawer offers. */
const PROVIDERS = new Set<string>(['qq', 'gmail', 'custom'])

/** Operations `/dsh-mail/action` implements. */
const ACTION_OPS = new Set<string>(['markRead', 'markUnread', 'flag', 'unflag', 'delete', 'move'])

/** Most UIDs one action may touch: one request must not hold a mailbox lock for long. */
const MAX_ACTION_UIDS = 500

/** Account ids are also credentials key segments, so they follow that segment's rule. */
const ACCOUNT_ID = /^[a-z][a-z0-9-]*$/

/** Whether a value is a JSON object rather than an array, `null` or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty, trimmed string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A member of a fixed set of names, or undefined. */
function named<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : undefined
}

/** A TCP port: an integer in 1–65535, accepting the text a number input sends. */
function port(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535
    ? numeric
    : undefined
}

/** Most senders the image whitelist holds; past this the file is the wrong shape for a list. */
export const MAX_TRUSTED_SENDERS = 200

/**
 * A sender address as the whitelist stores it.
 *
 * Lowercased because the same person writes as `Alice@Example.com` and
 * `alice@example.com` and means the same sender. The shape check is deliberately
 * loose — this decides a whitelist entry, not whether a mail can be delivered —
 * but it does have to be one address: an entry with a comma or a display name in
 * it would match nothing and be silently useless.
 * @param value - the address as some layer reported it.
 * @returns the key to store and compare, or undefined when it is not an address.
 */
export function senderKey(value: unknown): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const key = raw.toLowerCase()
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(key) ? key : undefined
}

/**
 * Read a stored whitelist: addresses only, deduplicated, in the order written.
 * @param value - the stored list, whatever it turned out to be.
 * @returns the usable entries, capped at {@link MAX_TRUSTED_SENDERS}.
 */
export function trustedSendersOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const senders: string[] = []
  for (const entry of value) {
    const key = senderKey(entry)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    senders.push(key)
    if (senders.length >= MAX_TRUSTED_SENDERS) break
  }
  return senders
}

/**
 * The whitelist with one sender added or removed.
 *
 * Adding puts the address first: it is the one a person is about to look for in
 * the list, and it means the cap drops whatever they stopped using rather than
 * the entry they just made.
 * @param current - the stored whitelist.
 * @param address - the address to add or remove, already normalized.
 * @param trusted - true to add, false to remove.
 * @returns the new list.
 */
export function withTrustedSender(current: readonly string[], address: string, trusted: boolean): string[] {
  const rest = trustedSendersOf(current).filter(one => one !== address)
  return trusted ? [address, ...rest].slice(0, MAX_TRUSTED_SENDERS) : rest
}

/**
 * The one preference the drawer can change.
 *
 * A whitelist edit travels as its own operation (see `MailConfigRequest`), so
 * this carries a single flag and nothing else — a "whole preferences object"
 * would let a stale drawer clear a list it never touched.
 * @param input - the posted `preferences`.
 * @returns the flag, or the field that was wrong.
 */
export function normalizePreferences(
  input: unknown,
): { ok: true; value: { loadRemoteImages: boolean } } | { ok: false; field: string; message: string } {
  if (!isRecord(input)) return { ok: false, field: 'preferences', message: '必须是对象' }
  const load = input['loadRemoteImages']
  if (typeof load !== 'boolean') return { ok: false, field: 'loadRemoteImages', message: '必须是布尔值' }
  return { ok: true, value: { loadRemoteImages: load } }
}

/** One filter group: strings only, trimmed, empties dropped, absent when nothing is left. */function filterGroup(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.flatMap((item) => {
    const kept = text(item)
    return kept === undefined ? [] : [kept]
  })
  return items.length === 0 ? undefined : items
}

/** The filter groups, with only the ones that carry something. */
function normalizeFilters(input: unknown): TriggerFilters {
  const source = isRecord(input) ? input : {}
  const from = filterGroup(source.from)
  const subject = filterGroup(source.subject)
  const keywords = filterGroup(source.keywords)
  return {
    ...(from === undefined ? {} : { from }),
    ...(subject === undefined ? {} : { subject }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(typeof source.unreadOnly === 'boolean' ? { unreadOnly: source.unreadOnly } : {}),
  }
}

/** The session options, only when the workspace they name could actually be opened. */
function normalizeSession(input: unknown): SessionTriggerOptions | undefined {
  if (!isRecord(input)) return undefined
  const workspacePath = text(input.workspacePath)
  // A relative path would be resolved against dsh's own working directory, which
  // is not what the user picked in the drawer: refuse it rather than guess.
  if (workspacePath === undefined || !isAbsolute(workspacePath)) return undefined
  const agentPreset = text(input.agentPreset)
  const permissionPreset = text(input.permissionPreset)
  const titleTemplate = text(input.titleTemplate)
  return {
    workspacePath,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(titleTemplate === undefined ? {} : { titleTemplate }),
  }
}

/**
 * One rule from the drawer.
 *
 * A rule naming a mode whose own parameters are unusable is dropped rather than
 * downgraded to `panel`: a rule the user thinks is running and is not would be
 * worse than one the drawer refuses to keep. Omitting the parameters entirely is
 * a different thing — that means "use the account's", which is how a rule list
 * stays readable when every rule shares one workspace.
 * @param input - what the request carried for this rule.
 * @returns the rule, or undefined when it cannot be acted on.
 */
function normalizeRule(input: unknown): TriggerRule | undefined {
  if (!isRecord(input)) return undefined
  const action: TriggerMode = named(input.action, TRIGGER_MODES) ?? 'panel'
  const name = text(input.name)
  const promptTemplate = text(input.promptTemplate)
  const base = {
    ...(name === undefined ? {} : { name }),
    when: normalizeFilters(input.when),
    action,
    ...(promptTemplate === undefined ? {} : { promptTemplate }),
  }
  if (action === 'session') {
    if (input.session === undefined) return base
    const session = normalizeSession(input.session)
    return session === undefined ? undefined : { ...base, session }
  }
  if (action === 'notify') {
    if (input.notify === undefined) return base
    const sessionId = text(isRecord(input.notify) ? input.notify.sessionId : undefined)
    return sessionId === undefined ? undefined : { ...base, notify: { sessionId } }
  }
  return base
}

/** The rules, when the account wrote any; an empty list means "no rules". */
function normalizeRules(value: unknown): readonly TriggerRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rules = value.map(normalizeRule).filter((rule): rule is TriggerRule => rule !== undefined)
  return rules.length === 0 ? undefined : rules
}

/**
 * Read a trigger the panel posted.
 *
 * A mode whose required option is missing falls back to `panel`: the message
 * still reaches the panel, and a trigger that could only ever fail is worse than
 * one the user has to switch on again. `unreadOnly` is left out when it is not a
 * boolean, which every reader of `TriggerFilters` already treats as `true`.
 * @param input - whatever the request body carried under `trigger`.
 * @returns a trigger that can be acted on.
 */
export function normalizeTrigger(input: unknown): TriggerConfig {
  const source = isRecord(input) ? input : {}
  const mode: TriggerMode = named(source.mode, TRIGGER_MODES) ?? 'panel'
  const filters = normalizeFilters(source.filters)
  // Only carried when the account wrote one: an absent field means "use the
  // built-in template", which is not the same as an empty one.
  const promptTemplate = text(source.promptTemplate)
  const prompt = promptTemplate === undefined ? {} : { promptTemplate }
  const rules = normalizeRules(source.rules)
  const withRules = rules === undefined ? {} : { rules }
  // A free-standing switch, not a mode: it rides along with whichever mode runs.
  const notifyWorkbench = source.notifyWorkbench === true ? { notifyWorkbench: true } : {}
  if (mode === 'session') {
    const session = normalizeSession(source.session)
    if (session === undefined) return { mode: 'panel', filters, ...prompt, ...withRules, ...notifyWorkbench }
    return { mode, session, filters, ...prompt, ...withRules, ...notifyWorkbench }
  }
  if (mode === 'notify') {
    const sessionId = text(isRecord(source.notify) ? source.notify.sessionId : undefined)
    if (sessionId === undefined) return { mode: 'panel', filters, ...prompt, ...withRules, ...notifyWorkbench }
    return { mode, notify: { sessionId }, filters, ...prompt, ...withRules, ...notifyWorkbench }
  }
  return { mode, filters, ...prompt, ...withRules, ...notifyWorkbench }
}

/**
 * Read one account the panel posted, before it has an id.
 * @param input - whatever the request body carried under `account`.
 * @returns the account fields, or the field that made them unusable.
 */
export function normalizeAccountInput(input: unknown): { ok: true; value: Omit<MailAccount, 'id'> & { id?: string } } | { ok: false; field: string; message: string } {
  if (!isRecord(input)) return { ok: false, field: 'account', message: 'The account must be a JSON object.' }
  const id = text(input.id)
  if (input.id !== undefined && (id === undefined || !ACCOUNT_ID.test(id))) {
    return { ok: false, field: 'id', message: 'An account id is lowercase letters, digits and dashes, and starts with a letter.' }
  }
  const address = text(input.address)
  if (address === undefined || !address.includes('@')) {
    return { ok: false, field: 'address', message: 'The address must not be empty and must contain an @.' }
  }
  const imapHost = text(input.imapHost)
  if (imapHost === undefined) return { ok: false, field: 'imapHost', message: 'The IMAP host must not be empty.' }
  const imapPort = port(input.imapPort)
  if (imapPort === undefined) {
    return { ok: false, field: 'imapPort', message: 'The IMAP port must be an integer between 1 and 65535.' }
  }
  const secure = input.secure === undefined ? true : input.secure
  if (typeof secure !== 'boolean') return { ok: false, field: 'secure', message: 'secure must be a boolean.' }
  const provider = named<MailProvider>(input.provider, PROVIDERS)
  if (provider === undefined) return { ok: false, field: 'provider', message: 'provider must be qq, gmail or custom.' }
  return {
    ok: true,
    value: {
      ...(id === undefined ? {} : { id }),
      name: text(input.name) ?? address,
      address,
      provider,
      imapHost,
      imapPort,
      secure,
      trigger: normalizeTrigger(input.trigger),
    },
  }
}

/**
 * Read the account the panel wants to try before saving.
 * @param input - whatever the request body carried under `draft`.
 * @returns the draft, or the field that made it unusable.
 */
export function normalizeDraft(input: unknown): { ok: true; value: DraftAccount } | { ok: false; field: string; message: string } {
  if (!isRecord(input)) return { ok: false, field: 'draft', message: 'The draft must be a JSON object.' }
  const address = text(input.address)
  if (address === undefined || !address.includes('@')) {
    return { ok: false, field: 'address', message: 'The address must not be empty and must contain an @.' }
  }
  const imapHost = text(input.imapHost)
  if (imapHost === undefined) return { ok: false, field: 'imapHost', message: 'The IMAP host must not be empty.' }
  const imapPort = port(input.imapPort)
  if (imapPort === undefined) {
    return { ok: false, field: 'imapPort', message: 'The IMAP port must be an integer between 1 and 65535.' }
  }
  const secure = input.secure === undefined ? true : input.secure
  if (typeof secure !== 'boolean') return { ok: false, field: 'secure', message: 'secure must be a boolean.' }
  if (typeof input.password !== 'string' || input.password.trim().length === 0) {
    return { ok: false, field: 'password', message: 'The authorization code must not be empty.' }
  }
  return { ok: true, value: { address, imapHost, imapPort, secure, password: input.password } }
}

/** The UIDs an action may touch: positive integers, at most {@link MAX_ACTION_UIDS} of them. */
function actionUids(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTION_UIDS) return undefined
  const uids: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return undefined
    uids.push(item)
  }
  return uids
}

/**
 * Read one mailbox action the panel posted.
 *
 * The UIDs are the dangerous part: one wrong range and the server marks the wrong
 * messages, so they are integers only and never inferred from text.
 * @param input - the parsed request body.
 * @returns the action, or the reason the route answers 400 with.
 */
export function normalizeAction(input: unknown): { ok: true; value: MailAction } | { ok: false; code: string; message: string } {
  const invalid = (message: string): { ok: false; code: string; message: string } => ({ ok: false, code: 'invalid_action', message })
  if (!isRecord(input)) return invalid('The action must be a JSON object.')
  const op = named<MailAction['op']>(input.op, ACTION_OPS)
  if (op === undefined) return invalid(`op must be one of ${[...ACTION_OPS].join(', ')}.`)
  const accountId = text(input.accountId)
  if (accountId === undefined) return invalid('accountId must not be empty.')
  const folder = text(input.folder)
  if (folder === undefined) return invalid('folder must not be empty.')
  const uids = actionUids(input.uids)
  if (uids === undefined) return invalid(`uids must hold 1 to ${String(MAX_ACTION_UIDS)} positive integers.`)
  if (op === 'move') {
    const targetFolder = text(input.targetFolder)
    if (targetFolder === undefined) return invalid('move needs a non-empty targetFolder.')
    return { ok: true, value: { op, accountId, folder, uids, targetFolder } }
  }
  return { ok: true, value: { op, accountId, folder, uids } }
}
