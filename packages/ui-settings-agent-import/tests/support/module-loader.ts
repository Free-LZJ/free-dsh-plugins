/**
 * Minimal stand-in for the harness Web shell's module table.
 *
 * A published client bundle is a browser artifact: it calls
 * `window.__ModuleLoader__.load({ id, factory })` and answers its imports
 * through the `require` the shell hands it. This file installs that loader in
 * the jsdom environment and seeds the same platform modules the shell seeds, so
 * specs can drive real client bundles outside the harness's own repository.
 */
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** The platform modules the shell seeds into every browser bundle. */
const PLATFORM: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['react', React],
  ['react/jsx-runtime', JsxRuntime],
  ['react-dom', ReactDOM],
  ['react-dom/client', ReactDOMClient],
  ['@deepseek-ai/cordis', Cordis],
  ['@deepseek-ai/dsh-client-store', Store],
  ['@deepseek-ai/dsh-client-ui-slots', Slots],
  ['@deepseek-ai/dsh-client-ui-primitives', Primitives],
])

/** One `load` request a browser bundle makes at evaluation time. */
interface LoadRequest {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

/** Module ids the bundles registered, in load order. */
const modules = new Map<string, unknown>()

/**
 * @param specifier - bare specifier a bundle reached.
 * @returns the platform module instance.
 */
function requirePlatform(specifier: string): unknown {
  const found = PLATFORM.get(specifier)
  if (found === undefined) throw new Error(`module-loader: no platform module for ${specifier}`)
  return found
}

if (typeof window !== 'undefined') {
  (window as unknown as { __ModuleLoader__: { load(request: LoadRequest): void } }).__ModuleLoader__ = {
    load: ({ id, factory }) => { modules.set(id, factory(requirePlatform)) },
  }
}

/**
 * Read the exports a browser bundle registered with the module table.
 * @param id - module id the bundle declared.
 * @returns its exports.
 */
export function clientModule<T>(id: string): T {
  const found = modules.get(id)
  if (found === undefined) throw new Error(`module-loader: module ${id} was never loaded`)
  return found as T
}
