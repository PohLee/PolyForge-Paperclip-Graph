/**
 * Test bootstrap: teach Node's ESM resolver that a relative `.js` specifier may name a `.ts`
 * file.
 *
 * ## Why this exists
 *
 * The plugin's sources follow the TypeScript `nodenext` convention — every relative import is
 * written with a `.js` extension — because `tsc` requires it. Node's `--experimental-strip-types`
 * executes the TypeScript directly and does **not** rewrite `.js` to `.ts`, so
 * `import { x } from "../src/x.js"` fails to resolve at runtime even though `tsc` is happy.
 *
 * `registerHooks` is the synchronous, in-thread form of the module customization API, so no
 * `--import` flag (and therefore no `package.json` change) is needed. A test file imports this
 * module *first* and then loads everything else — the bridge sources included — through dynamic
 * `import()`, which happens after this hook is installed.
 *
 * The hook is deliberately narrow: it only retries a *relative* `.js` specifier, and only when
 * the direct resolution fails. A real `.js` file always wins.
 */

import { registerHooks } from "node:module";

interface ResolveContext {
  conditions: string[];
  importAttributes: Record<string, string>;
  parentURL?: string;
}

interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
  importAttributes?: Record<string, string>;
}

let installed = false;

export function installTypeScriptResolver(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier: string, context: ResolveContext, nextResolve: (s: string, c: ResolveContext) => ResolveResult): ResolveResult {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        try {
          return nextResolve(specifier, context);
        } catch (originalError) {
          try {
            return nextResolve(`${specifier.slice(0, -".js".length)}.ts`, context);
          } catch {
            throw originalError;
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

installTypeScriptResolver();

/**
 * Load a module after the resolver is installed.
 *
 * The specifier is resolved against the *caller's* `import.meta.url`, so a test file writes
 * `load(new URL("../src/x.ts", import.meta.url))` and gets the path it means. Passing a bare
 * relative specifier would resolve against this file instead.
 */
export function load<T>(specifier: string | URL): Promise<T> {
  return import(specifier instanceof URL ? specifier.href : specifier) as Promise<T>;
}
