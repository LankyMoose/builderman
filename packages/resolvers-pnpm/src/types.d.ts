import type { InputResolver } from "builderman"
type X = string
/**
 * Options for pnpm.package() resolver.
 */
export interface PnpmPackageOptions {
  /**
   * Scope of the resolver:
   * - "local": Use pnpm-lock.yaml in the task's cwd (for standalone packages)
   * - "workspace": Find workspace root and use workspace's pnpm-lock.yaml
   * @default "workspace" if workspace is detected, otherwise "local"
   */
  scope?: "local" | "workspace"
}

/**
 * Pnpm resolver functions for including pnpm package dependencies in cache inputs.
 */
export declare const pnpm: {
  /**
   * Creates a resolver for the package in the task's cwd.
   * Automatically detects workspace context or uses local lockfile.
   *
   * @param options - Configuration options
   * @param options.scope - "local" to use lockfile in task's cwd, "workspace" to find workspace root.
   *                       Defaults to auto-detection based on workspace presence.
   *
   * @example
   * ```ts
   * // Auto-detect (workspace if found, otherwise local)
   * cache: {
   *   inputs: [
   *     "src",
   *     pnpm.package(),
   *   ],
   * }
   *
   * // Explicit workspace scope
   * cache: {
   *   inputs: [
   *     "src",
   *     pnpm.package({ scope: "workspace" }),
   *   ],
   * }
   *
   * // Explicit local scope
   * cache: {
   *   inputs: [
   *     "src",
   *     pnpm.package({ scope: "local" }),
   *   ],
   * }
   * ```
   */
  package: (options?: PnpmPackageOptions) => InputResolver
}
