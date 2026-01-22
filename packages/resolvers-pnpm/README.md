# @builderman/resolvers-pnpm

PNPM package dependency resolver for **builderman**. Automatically tracks pnpm package dependencies in cache inputs, ensuring tasks are invalidated when their dependencies change.

---

## Installation

```bash
pnpm add @builderman/resolvers-pnpm
```

Or with npm:

```bash
npm install @builderman/resolvers-pnpm
```

---

## Quick Start

```typescript
import { task } from "builderman"
import { pnpm } from "@builderman/resolvers-pnpm"

const server = task({
  name: "server",
  cwd: "packages/server",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          pnpm.package(), // Automatically tracks pnpm dependencies
        ],
        outputs: ["dist"],
      },
    },
  },
})
```

The resolver automatically detects whether you're in a workspace or standalone package and tracks the appropriate dependencies.

---

## Overview

**builderman** supports task-level caching to skip expensive work when inputs and outputs haven't changed. The `@builderman/resolvers-pnpm` package provides an **input resolver** that tracks pnpm package dependencies, so your cache invalidates when:

- Dependencies are added or removed
- Dependency versions change
- Transitive dependencies change
- The `pnpm-lock.yaml` file is updated

### Why Use This?

Without a dependency resolver, you'd need to manually track `package.json` and `pnpm-lock.yaml` files. However, this approach has limitations:

- **Workspace complexity**: In monorepos, you need to track the workspace root's lockfile, not just the local package
- **Package-specific tracking**: You only want to invalidate when _this package's_ dependencies change, not when unrelated workspace packages change
- **Transitive dependencies**: Changes to transitive dependencies should also invalidate the cache

The `pnpm.package()` resolver handles all of this automatically.

---

## API

### `pnpm.package(options?)`

Creates an input resolver for the package in the task's `cwd`.

**Parameters:**

- `options` (optional): Configuration object
  - `scope?: "local" | "workspace"` - Scope of the resolver
    - `"local"`: Use `pnpm-lock.yaml` in the task's `cwd` (for standalone packages)
    - `"workspace"`: Find workspace root and use workspace's `pnpm-lock.yaml` (for monorepo packages)
    - Default: Auto-detects based on workspace presence

**Returns:** An `InputResolver` that can be used in cache `inputs`.

---

## Usage Examples

### Auto-Detection (Recommended)

The resolver automatically detects whether you're in a workspace or standalone package:

```typescript
import { task } from "builderman"
import { pnpm } from "@builderman/resolvers-pnpm"

const myPackage = task({
  name: "my-package",
  cwd: "packages/my-package",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          pnpm.package(), // Auto-detects workspace or local
        ],
        outputs: ["dist"],
      },
    },
  },
})
```

### Explicit Workspace Scope

For monorepo packages, you can explicitly use workspace scope:

```typescript
const workspacePackage = task({
  name: "workspace-package",
  cwd: "packages/workspace-package",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: ["src", pnpm.package({ scope: "workspace" })],
        outputs: ["dist"],
      },
    },
  },
})
```

### Explicit Local Scope

For standalone packages (not in a workspace), use local scope:

```typescript
const standalonePackage = task({
  name: "standalone-package",
  cwd: ".",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: ["src", pnpm.package({ scope: "local" })],
        outputs: ["dist"],
      },
    },
  },
})
```

### Combining with Artifacts

You can combine the pnpm resolver with artifact dependencies:

```typescript
import { task, pipeline } from "builderman"
import { pnpm } from "@builderman/resolvers-pnpm"

const shared = task({
  name: "shared",
  cwd: "packages/shared",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: ["src", pnpm.package()],
        outputs: ["dist"],
      },
    },
  },
})

const backend = task({
  name: "backend",
  cwd: "packages/backend",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          shared.artifact("build"), // Track shared's build outputs
          pnpm.package(), // Track backend's dependencies
        ],
        outputs: ["dist"],
      },
    },
  },
})
```

---

## How It Works

### Dependency Closure Extraction

The resolver extracts only the **dependency closure** for the specific package, not the entire workspace. This means:

- ✅ Changes to `packages/package-a`'s dependencies invalidate `package-a`'s cache
- ❌ Changes to `packages/package-b`'s dependencies do **not** invalidate `package-a`'s cache
- ✅ Changes to transitive dependencies (dependencies of dependencies) are tracked

### Deterministic Hashing

The resolver computes a deterministic SHA-256 hash of:

1. The package's `package.json` (normalized)
2. The package's dependency closure from `pnpm-lock.yaml` (sorted)
3. The lockfile version

This ensures:

- Same dependencies → same hash (deterministic)
- Different dependencies → different hash (cache invalidation)
- Reproducible cache keys across different machines

### Lockfile Parsing

The resolver handles both JSON and YAML formats of `pnpm-lock.yaml`:

- Tries parsing as JSON first (some pnpm versions generate JSON-compatible lockfiles)
- Falls back to YAML parsing if JSON parsing fails
- Provides clear error messages if parsing fails

### Workspace Detection

For workspace scope, the resolver:

1. Looks for `pnpm-workspace.yaml` + `pnpm-lock.yaml` in parent directories
2. Prefers `pnpm-workspace.yaml` over `package.json` for workspace detection
3. Uses the workspace root's `pnpm-lock.yaml` for dependency resolution
4. Extracts only the package-specific importer entry from the lockfile

---

## Scope: Workspace vs Local

### Workspace Scope

**Use when:** Your package is part of a pnpm workspace (monorepo).

**Behavior:**

- Finds the workspace root by looking for `pnpm-workspace.yaml` + `pnpm-lock.yaml`
- Uses the workspace root's `pnpm-lock.yaml`
- Extracts dependencies from the package-specific importer entry (e.g., `importers["packages/my-package"]`)
- Only tracks dependencies for this specific package, not the entire workspace

**Example structure:**

```
workspace-root/
  ├── pnpm-workspace.yaml
  ├── pnpm-lock.yaml          ← Used for dependency resolution
  └── packages/
      └── my-package/
          ├── package.json     ← Task's cwd
          └── src/
```

### Local Scope

**Use when:** Your package is standalone (not in a workspace).

**Behavior:**

- Uses `pnpm-lock.yaml` in the task's `cwd`
- Extracts dependencies from the root importer entry (`importers["."]`)
- Requires `pnpm-lock.yaml` to exist in the task directory

**Example structure:**

```
my-package/
  ├── package.json
  ├── pnpm-lock.yaml          ← Used for dependency resolution
  └── src/
```

### Auto-Detection

When `scope` is not specified, the resolver:

1. Attempts to find a workspace root
2. If workspace found → uses `"workspace"` scope
3. If no workspace found → uses `"local"` scope

Auto-detection is recommended for most use cases.

---

## Error Handling

The resolver throws clear errors for common issues:

- **Missing `package.json`**: `No package.json found in task directory: <path>`
- **Missing `pnpm-lock.yaml`** (local scope): `No pnpm-lock.yaml found in task directory: <path>`
- **Missing workspace root** (workspace scope): `Cannot find pnpm workspace root. Make sure you're in a pnpm workspace with a pnpm-workspace.yaml and pnpm-lock.yaml file.`
- **Invalid lockfile**: `Failed to parse pnpm-lock.yaml: <error>`

---

## Requirements

- **builderman**: `^1.6.0` (peer dependency)
- **pnpm**: A pnpm project with `pnpm-lock.yaml`
- **Node.js**: Compatible with builderman's Node.js requirements

---

## See Also

- [builderman Documentation](https://www.npmjs.com/package/builderman) - Main builderman documentation
- [builderman Caching Guide](https://www.npmjs.com/package/builderman#caching) - Detailed caching documentation
- [Input Resolvers](https://www.npmjs.com/package/builderman#input-resolvers) - More about input resolvers

---
