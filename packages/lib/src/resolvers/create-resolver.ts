import { $RESOLVER_INTERNAL } from "../internal/constants.js"
import type { InputResolver, InputResolverConfig } from "./types.js"

/**
 * Creates a resolver API that can be used by resolver implementations.
 * This function provides access to the necessary symbols and types.
 *
 * @example
 * ```ts
 * import { createInputResolver } from "builderman/resolvers"
 *
 * export const myResolver = createInputResolver({
 *   kind: "my-resolver",
 *   resolve: (ctx: ResolveContext) => {
 *     return []
 *   }
 * })
 * ```
 */
export function createInputResolver(
  config: InputResolverConfig
): InputResolver {
  return { ...config, [$RESOLVER_INTERNAL]: true } satisfies InputResolver
}
