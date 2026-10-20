/**
 * Types for the one shim this package uses from `use-sync-external-store`.
 *
 * The published `@types` package covers the store only, and its `shim/`
 * subpath ships no declarations at all; one signature is cheaper than a
 * dependency, and it documents the two functions the hook actually calls.
 *
 * @module types/use-sync-external-store
 */

declare module 'use-sync-external-store/shim/with-selector' {
  /** @returns the selected slice, re-rendering only when the selector's answer changes. */
  export function useSyncExternalStoreWithSelector<S, SelectorOutput>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => S,
    getServerSnapshot: (() => S) | undefined,
    selector: (snapshot: S) => SelectorOutput,
    isEqual?: ((a: SelectorOutput, b: SelectorOutput) => boolean) | undefined,
  ): SelectorOutput
}
