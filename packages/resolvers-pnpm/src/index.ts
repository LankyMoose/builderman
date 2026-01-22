import { createInputResolver } from "builderman"
import type { InputResolver, ResolveContext, ResolvedInput } from "builderman"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

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
 * Simple YAML parser for pnpm-lock.yaml structure.
 * pnpm-lock.yaml is often JSON-compatible, so we try JSON first.
 * Falls back to a basic parser for YAML-specific syntax.
 */
function parseYamlLockfile(content: string): any {
  // Try parsing as JSON first (pnpm often generates JSON-compatible lockfiles)
  try {
    return JSON.parse(content)
  } catch {
    // Fall back to basic YAML parsing
    return parseBasicYaml(content)
  }
}

/**
 * Basic YAML parser for pnpm-lock.yaml.
 * This is a minimal parser that handles the structure we need.
 * Note: Modern pnpm uses YAML format. This is a simplified parser.
 * For production use, consider using a YAML library like 'yaml' or 'js-yaml'.
 */
function parseBasicYaml(_content: string): any {
  // For now, throw an error - proper YAML parsing requires a library
  // Most pnpm lockfiles are JSON-compatible, but if not, we need a YAML parser
  throw new Error(
    "pnpm-lock.yaml is not JSON-compatible. " +
      "Please install a YAML parser library (e.g., 'yaml' or 'js-yaml') or ensure your lockfile is in JSON format."
  )
}

/**
 * Finds the workspace root by looking for pnpm-workspace.yaml + pnpm-lock.yaml.
 * Prefers pnpm-workspace.yaml over package.json for workspace detection.
 */
function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  const root = path.parse(current).root

  while (current !== root) {
    const workspaceFile = path.join(current, "pnpm-workspace.yaml")
    const lockFile = path.join(current, "pnpm-lock.yaml")

    // Prefer pnpm-workspace.yaml + pnpm-lock.yaml
    if (fs.existsSync(workspaceFile) && fs.existsSync(lockFile)) {
      return current
    }

    // Fallback: package.json + pnpm-lock.yaml (could be workspace or single package)
    const packageFile = path.join(current, "package.json")
    if (fs.existsSync(packageFile) && fs.existsSync(lockFile)) {
      // Check if it's actually a workspace by looking for workspace packages
      try {
        const workspaceContent = fs.readFileSync(workspaceFile, "utf8")
        if (workspaceContent.includes("packages:")) {
          return current
        }
      } catch {
        // Not a workspace file
      }
    }

    current = path.dirname(current)
  }

  return null
}

/**
 * Gets the package path relative to workspace root for use in lockfile importers.
 */
function getPackagePath(packageDir: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, packageDir)
  // Normalize to forward slashes (pnpm uses forward slashes in lockfile)
  return relative === "." ? "." : relative.replace(/\\/g, "/")
}

/**
 * Extracts dependency closure from pnpm-lock.yaml.
 * Returns a sorted set of all dependency specifiers (package@version) reachable from the package.
 * Only includes dependencies for this specific package, not the entire workspace.
 */
function extractDependencyClosure(
  lockfile: any,
  packagePath: string,
  packageJson: any
): Set<string> {
  const closure = new Set<string>()
  const visited = new Set<string>()

  // Get the importer entry from lockfile
  const importers = lockfile.importers || {}
  const importer = importers[packagePath] || importers["."]

  if (!importer) {
    // If no importer found, fall back to package.json dependencies
    const allDeps: Record<string, string> = {
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
      ...packageJson.devDependencies,
    }
    for (const [name, version] of Object.entries(allDeps)) {
      closure.add(`${name}@${version}`)
    }
    return closure
  }

  // Recursively collect all dependencies from the lockfile
  // pnpm stores resolved versions in the importer's specifiers
  function collectDeps(deps: Record<string, string> | undefined) {
    if (!deps) return

    for (const [name, spec] of Object.entries(deps)) {
      const depKey = `${name}@${spec}`
      if (visited.has(depKey)) continue
      visited.add(depKey)

      closure.add(depKey)

      // Try to find the resolved package in the packages registry
      // pnpm lockfiles use registry keys like "/package-name/version"
      const packages = lockfile.packages || {}
      for (const pkg of Object.values(packages)) {
        if (typeof pkg === "object" && pkg !== null) {
          const pkgInfo = pkg as any
          // Check if this package matches the dependency
          // The registry key format is typically "/package-name/version" or "/@scope/package-name/version"
          if (pkgInfo.name === name) {
            // Found the package, collect its dependencies
            if (pkgInfo.dependencies) {
              collectDeps(pkgInfo.dependencies)
            }
            if (pkgInfo.optionalDependencies) {
              collectDeps(pkgInfo.optionalDependencies)
            }
            break
          }
        }
      }
    }
  }

  // Start from the package's dependencies in the importer
  collectDeps(importer.dependencies)
  collectDeps(importer.optionalDependencies)
  collectDeps(importer.devDependencies)

  return closure
}

/**
 * Computes a deterministic hash of the dependency closure.
 * Only includes dependencies for the specific package, not the entire lockfile.
 */
function computeDependencyHash(
  packageDir: string,
  lockFileDir: string,
  packageJson: any,
  scope: "local" | "workspace"
): string {
  const hash = createHash("sha256")

  // Include the package's package.json (normalized)
  const packageJsonStr = JSON.stringify(
    packageJson,
    Object.keys(packageJson).sort()
  )
  hash.update("package.json:")
  hash.update(packageJsonStr)
  hash.update("\n")

  // Parse lockfile
  const lockFilePath = path.join(lockFileDir, "pnpm-lock.yaml")
  if (!fs.existsSync(lockFilePath)) {
    throw new Error(`pnpm-lock.yaml not found at ${lockFilePath}`)
  }

  const lockfileContent = fs.readFileSync(lockFilePath, "utf8")
  const lockfile = parseYamlLockfile(lockfileContent)

  // Get package path for workspace, or "." for local
  const packagePath =
    scope === "workspace" ? getPackagePath(packageDir, lockFileDir) : "."

  // Extract only the dependency closure for this package
  const closure = extractDependencyClosure(lockfile, packagePath, packageJson)

  // Hash dependencies in sorted order for determinism
  const sortedDeps = Array.from(closure).sort()
  hash.update("dependencies:")
  for (const dep of sortedDeps) {
    hash.update(dep)
    hash.update("\n")
  }

  // Also include lockfile version for safety
  if (lockfile.lockfileVersion) {
    hash.update("lockfileVersion:")
    hash.update(String(lockfile.lockfileVersion))
    hash.update("\n")
  }

  return hash.digest("hex")
}

/**
 * Creates a pnpm package dependency resolver.
 */
function createPnpmPackageResolver(
  options: PnpmPackageOptions = {}
): InputResolver {
  return createInputResolver({
    name: "pnpm",
    resolve(ctx: ResolveContext): ResolvedInput[] {
      const packageJsonPath = path.join(ctx.taskCwd, "package.json")
      if (!fs.existsSync(packageJsonPath)) {
        throw new Error(
          `No package.json found in task directory: ${ctx.taskCwd}`
        )
      }

      let packageJson: any
      let packageName: string
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
        packageName = packageJson.name || path.basename(ctx.taskCwd)
      } catch {
        throw new Error(`Failed to parse package.json in ${ctx.taskCwd}`)
      }

      // Determine scope
      let scope: "local" | "workspace" = options.scope || "workspace"
      const workspaceRoot = ctx.rootCwd || findWorkspaceRoot(ctx.taskCwd)

      // Auto-detect scope if not specified
      if (!options.scope) {
        if (workspaceRoot && workspaceRoot !== ctx.taskCwd) {
          scope = "workspace"
        } else {
          scope = "local"
        }
      }

      let lockFileDir: string
      if (scope === "workspace") {
        if (!workspaceRoot) {
          throw new Error(
            `Cannot find pnpm workspace root. Make sure you're in a pnpm workspace with a pnpm-workspace.yaml and pnpm-lock.yaml file.`
          )
        }
        lockFileDir = workspaceRoot
      } else {
        // Local scope - lockfile must be in task cwd
        const lockFilePath = path.join(ctx.taskCwd, "pnpm-lock.yaml")
        if (!fs.existsSync(lockFilePath)) {
          throw new Error(
            `No pnpm-lock.yaml found in task directory: ${ctx.taskCwd}. ` +
              `pnpm.package({ scope: "local" }) requires pnpm-lock.yaml to be in the task's cwd.`
          )
        }
        lockFileDir = ctx.taskCwd
      }

      const hash = computeDependencyHash(
        ctx.taskCwd,
        lockFileDir,
        packageJson,
        scope
      )

      return [
        {
          type: "virtual",
          kind: "pnpm-deps",
          hash,
          description: `pnpm dependencies for ${packageName} (${scope})`,
        },
        // Include package.json as file input (lockfile is internal to the resolver)
        {
          type: "file",
          path: "package.json",
        },
      ]
    },
  })
}

/**
 * Pnpm resolver functions for including pnpm package dependencies in cache inputs.
 */
export const pnpm = {
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
  package(options?: PnpmPackageOptions): InputResolver {
    return createPnpmPackageResolver(options)
  },
}
