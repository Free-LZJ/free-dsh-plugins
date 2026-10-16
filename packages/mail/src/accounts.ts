/**
 * Account identity, and the one place an authorization code is allowed to be.
 *
 * The plugin's own files never hold a secret: an account is an id, an address
 * and a server, and the code the server wants travels through the host's
 * credentials service under `dsh-mail/<id>`. Keeping the split here means every
 * other module can treat an account record as public — it is what the panel
 * gets — while the code is only ever read to open a connection.
 *
 * @module @free-lzj/dsh-mail/accounts
 */

import { createHash } from 'node:crypto'
import type { DraftAccount, MailProvider, RouteResult } from './types.ts'

/** Scope segment of every credentials key this plugin writes. */
const CREDENTIAL_SCOPE = 'dsh-mail'

/** The part of the host credentials service this plugin uses. */
export interface CredentialsLike {
  readRecord(key: string): Promise<{ kind: string; key?: string } | undefined>
  modifyRecord(key: string, mutate: (current: unknown) => unknown): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

/**
 * Opens one connection and reports what it found, without saving anything.
 *
 * Injected rather than implemented here: it belongs to the IMAP module, and a
 * test can answer it without a server.
 */
export type ProbeFn = (draft: DraftAccount, timeoutSeconds: number) => Promise<{ ok: true; mailboxes: number } | { ok: false; code: string; message: string }>

/**
 * The stable id of one mailbox.
 *
 * Derived from the address and the provider so that saving the same mailbox
 * twice updates one account instead of creating a second, and case-insensitive
 * because the server treats addresses that way. The leading `m` is what keeps
 * the id inside `/^[a-z][a-z0-9-]*$/` — a hex digest may start with a digit, and
 * this id is also a credentials key segment, which may not.
 * @param address - the address as the user typed it.
 * @param provider - which provider the account is with.
 * @returns the id.
 */
export function accountIdFor(address: string, provider: MailProvider): string {
  const digest = createHash('sha256').update(`${provider}:${address.trim().toLowerCase()}`).digest('hex')
  return `m${digest.slice(0, 15)}`
}

/**
 * Where one account's authorization code is stored.
 * @param accountId - the account id, as {@link accountIdFor} produced it.
 * @returns the credentials key.
 */
// ponytail: the credentials package exports credentialKey() at runtime, and this
// Host half has no externals configured — importing it would inline the whole
// library into the bundle (detailed design §2). It joins a scope and an id and
// checks two regexes, so those two lines live here instead.
export function credentialKeyFor(accountId: string): string {
  return `${CREDENTIAL_SCOPE}/${accountId}`
}

/**
 * The error a route turns into `503 credentials_unavailable`.
 *
 * The code is the contract: callers check `error.code`, not the message.
 */
function credentialsUnavailable(): Error {
  return Object.assign(
    new Error('The credentials service is not available, so the mail plugin cannot store or read an authorization code.'),
    { code: 'credentials_unavailable' },
  )
}

/** The service, or the error that says the host did not mount it. */
function requireCredentials(credentials: CredentialsLike | undefined): CredentialsLike {
  if (credentials === undefined) throw credentialsUnavailable()
  return credentials
}

/**
 * Read one account's authorization code.
 * @param credentials - the host service, or undefined when it is not mounted.
 * @param accountId - the account to read for.
 * @returns the code, or undefined when nothing usable is configured.
 */
export async function readPassword(credentials: CredentialsLike | undefined, accountId: string): Promise<string | undefined> {
  if (credentials === undefined) return undefined
  const record = await credentials.readRecord(credentialKeyFor(accountId))
  if (record === undefined || record.kind !== 'api-key') return undefined
  return typeof record.key === 'string' && record.key.length > 0 ? record.key : undefined
}

/**
 * Store one account's authorization code, replacing whatever was there.
 *
 * The read-modify-write runs under the service's own lock, which is the reason
 * to use it at all: the file it owns is written by other plugins too.
 * @param credentials - the host service.
 * @param accountId - the account to write for.
 * @param password - the authorization code or app password.
 */
export async function writePassword(credentials: CredentialsLike | undefined, accountId: string, password: string): Promise<void> {
  await requireCredentials(credentials).modifyRecord(credentialKeyFor(accountId), () => ({ kind: 'api-key', key: password }))
}

/**
 * Forget one account's authorization code.
 * @param credentials - the host service.
 * @param accountId - the account to clear.
 */
export async function removePassword(credentials: CredentialsLike | undefined, accountId: string): Promise<void> {
  await requireCredentials(credentials).deleteRecord(credentialKeyFor(accountId))
}

/**
 * Try one draft account and report what the server said.
 *
 * Nothing is persisted: the account only exists once the user saves it, and a
 * failed probe is an answer the drawer shows, not an error the route throws.
 * @param probe - the connection attempt, injected by the IMAP module.
 * @param draft - the account to try.
 * @param timeoutSeconds - how long the attempt may take.
 * @returns the probe's answer, with the mailbox count when it connected.
 */
export async function testAccount(probe: ProbeFn, draft: DraftAccount, timeoutSeconds: number): Promise<RouteResult & { mailboxes?: number }> {
  const result = await probe(draft, timeoutSeconds)
  return result.ok ? { ok: true, mailboxes: result.mailboxes } : { ok: false, code: result.code, message: result.message }
}
