import { $RESOLVER_INTERNAL } from "../internal/constants.js"

/**
 * Context provided to input resolvers when they are resolved.
 */
export interface ResolveContext {
  /**
   * The working directory of the task that is using this resolver.
   */
  taskCwd: string
  /**
   * The root working directory of the workspace.
   */
  rootCwd: string
}

/**
 * A resolved input represents a concrete file or artifact that should be
 * included in the cache key. Resolvers produce these from high-level intents.
 */
export type ResolvedInput =
  | {
      /**
       * A file path input (relative to taskCwd or absolute).
       */
      type: "file"
      path: string
    }
  | {
      /**
       * A virtual input with a computed hash.
       * Used for structured data that doesn't map to files directly.
       */
      type: "virtual"
      kind: string
      hash: string
      /**
       * Human-readable description for debugging/visualization.
       */
      description: string
    }

/**
 * An input resolver is a function that takes a resolve context and returns
 * an array of resolved inputs. Resolvers are used to expand high-level
 * intents (like "include pnpm dependencies") into concrete cache inputs.
 */
export interface InputResolverConfig {
  /**
   * The name of the resolver (e.g., "pnpm", "cargo", "dotnet").
   * Used for debugging and visualization.
   */
  name: string
  /**
   * Resolves the inputs for this resolver.
   * @param ctx - The resolution context
   * @returns An array of resolved inputs
   */
  resolve: (ctx: ResolveContext) => ResolvedInput[]
}

export interface InputResolver extends InputResolverConfig {
  readonly name: string

  resolve(ctx: ResolveContext): ResolvedInput[]
  readonly [$RESOLVER_INTERNAL]: true
}
