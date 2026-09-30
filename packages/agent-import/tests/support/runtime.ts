/**
 * Local stand-ins for the DeepSeek Harness client test runtime the specs were
 * written against. The monorepo's `@deepseek-ai/dsh-client-test-runtime` cannot
 * be used from npm: its published `lib/index.js` reaches
 * `@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts`, a source path that
 * only exists inside that repository. These four doubles carry the same
 * behavior the specs rely on.
 */
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Value import (not a re-export of a type) so `instanceof` inside the settings
 * service matches the failure this file constructs.
 */
export { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Handle over one stubbed settings scope: the scope, its write spies, and publication controls. */
export interface StubConfigForm<T> {
  /** The scope face handed to the service under test. */
  scope: ConfigForm<T>
  /** Spy behind `scope.set`; resolves immediately. */
  set: ReturnType<typeof vi.fn>
  /** Spy behind `scope.mutate`; resolves immediately. */
  mutate: ReturnType<typeof vi.fn<ConfigForm<T>['mutate']>>
  /** Spy behind `scope.unset`; resolves immediately. */
  unset: ReturnType<typeof vi.fn>
  /** @returns how many listeners are currently subscribed (disposal assertions). */
  listenerCount(): number
  /**
   * Replace part of the snapshot and notify subscribers, as a Host acceptance would.
   * @param next - snapshot fields to replace.
   */
  publish(next: Partial<ConfigFormSnapshot<T>>): void
}

/**
 * Build an in-memory settings scope for service specs: starts in the host
 * loading state, records writes, and lets the test publish Host acceptances.
 * @returns the stub handle.
 */
export function stubConfigForm<T>(): StubConfigForm<T> {
  let snapshot: ConfigFormSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(() => Promise.resolve(true))
  const mutate = vi.fn<ConfigForm<T>['mutate']>(() => Promise.resolve(true))
  const unset = vi.fn(() => Promise.resolve(true))
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate,
      set,
      unset,
    },
    set,
    mutate,
    unset,
    listenerCount: () => listeners.size,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Build a translate stub resolving through `dicts` in order (namespace first,
 * then the shared common vocabulary), falling back to the key, and
 * interpolating `{name}` templates the way the locale runtime does.
 * @param dicts - dictionaries consulted in order.
 * @returns the translate function (assignable to any `t` seat).
 */
export function makeTranslate(
  ...dicts: readonly Record<string, string>[]
): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    let template = key
    for (const dict of dicts) {
      const hit = dict[key]
      if (hit !== undefined) {
        template = hit
        break
      }
    }
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

/**
 * Bind a bare observable source to a typed selector hook through React's
 * external-store shim, capturing subscribe/getSnapshot once per source so
 * components never resubscribe across renders.
 * @param source - snapshot source (engine store, Session object, store instance).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(select: (state: T) => S, equal?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, select, equal)
  }
}

/**
 * Remote service test double for the forwarded-event path. Feature specs need
 * `ctx.remote.$on` to exist and one scripted namespace face per injected
 * `remote.<name>`, but not the wire.
 */
export class TestRemote {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()

  /** Fixed Host facts mirrored from the production `ctx.remote.$host`. */
  $host: { home: string | undefined; isLoopback: boolean } = { home: undefined, isLoopback: true }

  /**
   * Register the double as `ctx.remote`, plus one service per scripted namespace.
   * @param ctx - the spec's root Context.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  constructor(private readonly ctx: Context, namespaces: Readonly<Record<string, object>> = {}) {
    for (const name of Object.keys(namespaces)) {
      if (name in this) {
        throw new TypeError(`TestRemote: scripted namespace "${name}" would shadow the double's own member`)
      }
    }
    ctx.provide('remote', this)
    this.provideNamespaces(namespaces)
  }

  /**
   * Add scripted namespace faces to this Remote service.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  provideNamespaces(namespaces: Readonly<Record<string, object>>): void {
    Object.assign(this, namespaces)
    for (const [name, face] of Object.entries(namespaces)) this.ctx.provide(`remote.${name}`, face)
  }

  /**
   * Deliver one forwarded host event to its subscribers, standing in for the
   * carrier that owns the frame sink.
   * @param event - forwarded host event name.
   * @param args - the Host argument list, verbatim.
   */
  emit(event: string, args: readonly unknown[]): void {
    const listeners = this.subscriptions.get(event)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(...args as never[])
  }

  /**
   * Subscribe to one forwarded host event.
   * @param event - forwarded host event name.
   * @param listener - receives the Host argument list verbatim.
   * @returns disposer removing this subscription.
   */
  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Generated-namespace mount, unsupported by this double.
   * @returns never; always rejects.
   */
  $mount(): Promise<() => Promise<void>> {
    return Promise.reject(new Error('TestRemote: $mount needs the real Client Remote service'))
  }
}
