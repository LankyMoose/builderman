# @builderman/resolvers-pnpm

PNPM package dependency resolver for builderman.

This package provides a resolver that includes pnpm package dependencies in cache inputs, ensuring that tasks are invalidated when their dependencies change.

## Installation

```bash
pnpm add @builderman/resolvers-pnpm
```

## Usage

```typescript
import { pnpm } from "@builderman/resolvers-pnpm"
import { task } from "builderman"

const myTask = task({
  name: "build",
  cwd: "packages/my-package",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          pnpm.package(), // Automatically detects workspace or local
        ],
        outputs: ["dist"],
      },
    },
  },
})
```

## API

### `pnpm.package(options?)`

Creates a resolver for the package in the task's cwd.

**Options:**
- `scope?: "local" | "workspace"` - Defaults to auto-detection
  - `"local"`: Use pnpm-lock.yaml in the task's cwd
  - `"workspace"`: Find workspace root and use workspace's pnpm-lock.yaml

**Examples:**

```typescript
// Auto-detect (recommended)
pnpm.package()

// Explicit workspace scope
pnpm.package({ scope: "workspace" })

// Explicit local scope
pnpm.package({ scope: "local" })
```

## How It Works

The resolver:
1. Parses the pnpm-lock.yaml file
2. Extracts only the dependency closure for the specific package (not the entire workspace)
3. Computes a deterministic hash of the dependencies
4. Includes this hash in the cache key

This ensures that:
- Tasks are invalidated when their dependencies change
- Tasks are NOT invalidated when unrelated workspace packages change
- The cache key is deterministic and reproducible
