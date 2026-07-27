/**
 * Namespaced development logging. `import.meta.env.DEV` is inlined at build
 * time, so production resolves this to a no-op and the console call itself is
 * dropped as dead code.
 *
 * The call sites survive minification, which means their arguments are still
 * evaluated in production even though nothing is printed. That is fine for
 * occasional logging; in a per-frame path, guard the call rather than building
 * a template literal that is immediately thrown away.
 *
 * The namespace is a closed union on purpose: a typo should not silently
 * create a new logging channel nobody is watching.
 */

export type DebugNamespace =
  "audio" | "input" | "loop" | "ml" | "physics" | "render" | "room";

type DebugFn = (namespace: DebugNamespace, ...args: readonly unknown[]) => void;

const logToConsole: DebugFn = (namespace, ...args) => {
  // The single sanctioned console call in the codebase.
  // eslint-disable-next-line no-console
  console.log(`[${namespace}]`, ...args);
};

const noop: DebugFn = () => {};

export const debug: DebugFn = import.meta.env.DEV ? logToConsole : noop;
