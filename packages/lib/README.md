# builderman

#### A dependency-aware task runner for building, developing, and orchestrating complex workflows.

**builderman** lets you define tasks with explicit dependencies, lifecycle hooks, and multiple execution modes (`dev`, `build`, `deploy`, etc.), then compose them into pipelines that run **deterministically**, **observably**, and **safely**.

It is designed for monorepos, long-running development processes, and CI/CD pipelines where **cleanup, cancellation, and failure handling matter**.

---

## Table of Contents

> - [Key Features](#key-features)
> - [Installation](#installation)
> - [Quick Start](#quick-start)
> - [Core Concepts](#core-concepts)
>   - [Tasks](#tasks)
>   - [Commands & Modes](#commands--modes)
>   - [Environment Variables](#environment-variables)
>   - [Dependencies](#dependencies)
>     - [Command-Level Dependencies](#command-level-dependencies)
>   - [Pipelines](#pipelines)
>     - [Concurrency Control](#concurrency-control)
>     - [Pipeline Composition](#pipeline-composition)
> - [Error Handling Guarantees](#error-handling-guarantees)
> - [Cancellation](#cancellation)
> - [Teardown](#teardown)
>   - [Basic Teardown](#basic-teardown)
>   - [Teardown Callbacks](#teardown-callbacks)
>   - [Teardown Execution Rules](#teardown-execution-rules)
> - [Skipping Tasks](#skipping-tasks)
>   - [Strict Mode](#strict-mode)
>   - [Task-Level Skip Override](#task-level-skip-override)
> - [Caching](#caching)
>   - [Cache Inputs](#cache-inputs)
>     - [File Paths](#file-paths)
>     - [Artifacts](#artifacts)
>     - [Input Resolvers](#input-resolvers)
> - [Execution Statistics](#execution-statistics)
>   - [Pipeline Statistics](#pipeline-statistics)
>   - [Task Statistics](#task-statistics)
> - [Advanced Examples](#advanced-examples)
> - [When Should I Use builderman?](#when-should-i-use-builderman)

## Key Features

- 🧩 **Explicit dependency graph** — tasks run only when their dependencies are satisfied
- 🔁 **Multi-mode commands** — `dev`, `build`, `deploy`, or any custom mode
- ⏳ **Readiness detection** — wait for long-running processes to become “ready”
- 🧹 **Guaranteed teardown** — automatic cleanup in reverse dependency order
- 🛑 **Cancellation support** — abort pipelines using `AbortSignal`
- 📊 **Rich execution statistics** — always available, even on failure
- ❌ **Never throws** — failures are returned as structured results
- 🧱 **Composable pipelines** — pipelines can be converted into tasks
- 💾 **Task-level caching** — skip tasks when inputs and outputs haven't changed
- 🎯 **Artifact dependencies** — reference outputs from other tasks in cache inputs
- 🔌 **Input resolvers** — track package dependencies and other dynamic inputs

---

## Installation

```sh
npm install builderman
```

---

## Quick Start

```ts
import { task, pipeline } from "builderman"

const build = task({
  name: "build",
  commands: {
    build: "tsc",
    dev: "tsc --watch",
  },
})

const test = task({
  name: "test",
  commands: {
    build: "npm test",
  },
  dependencies: [build],
})

const deploy = task({
  name: "deploy",
  commands: {
    build: "npm run deploy",
  },
  dependencies: [test],
})

const result = await pipeline([build, test, deploy]).run({
  command: "build",
})
console.log(result)
```

This defines a simple CI pipeline where `test` runs only after `build` completes, and `deploy` runs only after `test` completes. The result is a structured object with detailed execution statistics.

---

## Core Concepts

### Tasks

A **task** represents a unit of work. Each task:

- Has a unique name
- Defines commands for one or more modes
- May depend on other tasks
- May register teardown logic
- Has an optional working directory (`cwd`, defaults to `"."`)

```ts
import { task } from "builderman"

const myPackage = task({
  name: "myPackage",
  commands: {
    build: "tsc",
    dev: {
      run: "tsc --watch",
      readyWhen: (stdout) => stdout.includes("Watching for file changes."),
    },
  },
  cwd: "packages/myPackage",
})
```

---

### Commands & Modes

Each task can define commands for different **modes** (for example `dev`, `build`, `deploy`).

When running a pipeline:

- If `command` is provided, that mode is used
- Otherwise:
  - `"build"` is used when `NODE_ENV === "production"`
  - `"dev"` is used in all other cases

Commands may be:

- A string (executed directly), or
- An object with:
  - `run`: the command to execute
  - `dependencies`: optional array of tasks that this command depends on (see [Command-Level Dependencies](#command-level-dependencies))
  - `readyWhen`: a predicate that marks the task as ready - useful for long-running processes that can allow dependents to start before they exit (e.g. a "watch" process)
  - `teardown`: cleanup logic to run after completion
  - `env`: environment variables specific to this command
  - `cache`: configuration for task-level caching (see [Caching](#caching))

---

### Environment Variables

Environment variables can be provided at multiple levels, with more specific levels overriding less specific ones:

**Precedence order (highest to lowest):**

1. Command-level `env` (in command config)
2. Task-level `env` (in task config)
3. Pipeline-level `env` (in `pipeline.run()`)
4. Process environment variables

#### Command-Level Environment Variables

```ts
const server = task({
  name: "server",
  commands: {
    dev: {
      run: "node server.js",
      env: {
        PORT: "3000",
        NODE_ENV: "development",
      },
    },
  },
})
```

#### Task-Level Environment Variables

```ts
const server = task({
  name: "server",
  env: {
    // in both dev and build, the PORT environment variable will be set to "3000"
    PORT: "3000",
  },
  commands: {
    dev: {
      run: "node server.js",
      env: {
        LOG_LEVEL: "debug",
        // overrides the task-level PORT environment variable
        PORT: "4200",
      },
    },
    build: {
      run: "node server.js",
      env: {
        LOG_LEVEL: "info",
      },
    },
  },
})
```

#### Pipeline-Level Environment Variables

```ts
const result = await pipeline([server]).run({
  env: {
    DATABASE_URL: "postgres://localhost/mydb",
    REDIS_URL: "redis://localhost:6379",
  },
})
```

#### Nested Pipeline Environment Variables

When converting a pipeline to a task, you can provide environment variables that will be merged with the outer pipeline's environment:

```ts
const innerPipeline = pipeline([
  /* ... */
])
const innerTask = innerPipeline.toTask({
  name: "inner",
  env: {
    INNER_VAR: "inner-value",
  },
})

const outerPipeline = pipeline([innerTask])
const result = await outerPipeline.run({
  env: {
    OUTER_VAR: "outer-value",
  },
})
```

In this example, tasks in `innerPipeline` will receive both `INNER_VAR` and `OUTER_VAR`, with `INNER_VAR` taking precedence if there's a conflict.

---

### Dependencies

Tasks may depend on other tasks. A task will not start until all its dependencies have completed (or been skipped).

When a task has task-level dependencies, each command in the task automatically depends on the command with the same name in the dependency task (if it exists). For example, if a task has commands `{ dev, build }` and depends on another task with commands `{ dev, build }`, then this task's `dev` command will depend on the dependency's `dev` command, and this task's `build` command will depend on the dependency's `build` command.

```ts
const server = task({
  name: "server",
  commands: {
    dev: "node server.js",
    build: "node server.js",
  },
  dependencies: [shared], // Both "build" and "dev" commands will depend on shared's matching commands, if they exist
})
```

#### Command-Level Dependencies

You can also specify dependencies at the command level for more granular control. This is useful when different commands have different dependency requirements.

```ts
const database = task({
  name: "database",
  commands: {
    dev: {
      run: "docker compose up",
      readyWhen: (output) => output.includes("ready"),
      teardown: "docker compose down",
    },
  },
})

const migrations = task({
  name: "migrations",
  commands: {
    build: "npm run migrate",
  },
})

const api = task({
  name: "api",
  commands: {
    // Build only needs migrations
    build: {
      run: "npm run build",
      dependencies: [migrations],
    },

    // Dev needs both the database and migrations
    dev: {
      run: "npm run dev",
      dependencies: [database, migrations],
    },
  },
})
```

---

### Pipelines

A **pipeline** executes a set of tasks according to their dependency graph.

```ts
import { pipeline } from "builderman"

const result = await pipeline([backend, frontend]).run({
  command: "dev",
  onTaskBegin: (name) => {
    console.log(`[${name}] starting`)
  },
  onTaskComplete: (name) => {
    console.log(`[${name}] complete`)
  },
})
```

#### Concurrency Control

By default, pipelines run as many tasks concurrently as possible (limited only by dependencies). You can limit concurrent execution using `maxConcurrency`:

```ts
const result = await pipeline([task1, task2, task3, task4, task5]).run({
  maxConcurrency: 2, // At most 2 tasks will run simultaneously
})
```

When `maxConcurrency` is set:

- Tasks that are ready to run (dependencies satisfied) will start up to the limit
- As tasks complete, new ready tasks will start to maintain the concurrency limit
- Dependencies are still respected — a task won't start until its dependencies complete

This is useful for:

- Limiting resource usage (CPU, memory, network)
- Controlling database connection pools
- Managing API rate limits
- Reducing system load in CI environments

If `maxConcurrency` is not specified, there is no limit (tasks run concurrently as dependencies allow).

---

### Pipeline Composition

Pipelines can be converted into tasks and composed like any other unit of work.

```ts
const backend = task({
  name: "backend",
  cwd: "packages/backend",
  commands: { build: "npm run build" },
})

const frontend = task({
  name: "frontend",
  cwd: "packages/frontend",
  commands: { build: "npm run build" },
})

const productionMonitoring = task({
  name: "production-monitoring",
  cwd: "packages/production-monitoring",
  commands: { build: "npm run build" },
})

// Convert a pipeline into a task
const app = pipeline([backend, frontend]).toTask({
  name: "app",
  dependencies: [productionMonitoring], // The app task depends on productionMonitoring
})

const result = await pipeline([app, productionMonitoring]).run()
```

When a pipeline is converted to a task:

- It becomes a **single node** in the dependency graph, with the tasks in the pipeline as subtasks
- The tasks in the pipeline all must either complete or be flagged as 'ready' or 'skipped' before dependents can start
- You can specify dependencies and environment variables for the pipeline task
- The tasks in the pipeline are tracked as subtasks in execution statistics, and are included in the summary object

---

## Error Handling Guarantees

**builderman pipelines never throw.**

All failures — including task errors, invalid configuration, cancellation, and process termination — are reported through a structured `RunResult`.

```ts
import { pipeline, PipelineError } from "builderman"

const result = await pipeline([backend, frontend]).run()

if (!result.ok) {
  switch (result.error.code) {
    case PipelineError.Aborted:
      console.error("Pipeline was cancelled")
      break
    case PipelineError.TaskFailed:
      console.error("Task failed:", result.error.message)
      break
    case PipelineError.TaskReadyTimeout:
      console.error("Task was not ready in time:", result.error.message)
      break
    case PipelineError.TaskCompletedTimeout:
      console.error("Task did not complete in time:", result.error.message)
      break
    case PipelineError.ProcessTerminated:
      console.error("Process terminated:", result.error.message)
      break
    case PipelineError.InvalidTask:
      console.error("Invalid task configuration:", result.error.message)
      break
  }
}
```

Execution statistics are **always available**, even on failure.

---

## Cancellation

You can cancel a running pipeline using an `AbortSignal`.

```ts
const controller = new AbortController()

const runPromise = pipeline([backend, frontend]).run({
  signal: controller.signal,
})

// Cancel after 5 seconds
setTimeout(() => {
  controller.abort()
}, 5000)

const result = await runPromise

if (!result.ok && result.error.code === PipelineError.Aborted) {
  console.error("Pipeline was cancelled")
  console.log(`Tasks still running: ${result.stats.summary.running}`)
}
```

---

## Teardown

Tasks may specify teardown commands that run automatically when a task completes or fails.

Teardowns are executed **in reverse dependency order** (dependents before dependencies) to ensure safe cleanup.

### Basic Teardown

```ts
const dbTask = task({
  name: "database",
  commands: {
    dev: {
      run: "docker-compose up",
      teardown: "docker-compose down",
    },
    build: "echo build",
  },
})
```

---

### Teardown Callbacks

You can observe teardown execution using callbacks. Teardown failures do **not** cause the pipeline to fail — they are best-effort cleanup operations.

```ts
const result = await pipeline([dbTask]).run({
  onTaskTeardown: (taskName) => {
    console.log(`[${taskName}] starting teardown`)
  },
  onTaskTeardownError: (taskName, error) => {
    console.error(`[${taskName}] teardown failed: ${error.message}`)
  },
})
```

Teardown results are recorded in task statistics.

---

### Teardown Execution Rules

Teardowns run when:

- The command entered the running state
- The pipeline completes successfully
- The pipeline fails after tasks have started

Teardowns do **not** run when:

- The task was skipped
- The task failed before starting (spawn error)
- The pipeline never began execution

---

## Skipping Tasks

Tasks can be skipped in two scenarios:

1. **Missing command**: If a task does not define a command for the current mode, it is **skipped** by default
2. **Cache hit**: If a task has cache configuration and the cache matches, the task is **skipped** (see [Caching](#caching))

Skipped tasks:

- Participate in the dependency graph
- Resolve immediately
- Unblock dependent tasks
- Do not execute commands or teardowns

```ts
const dbTask = task({
  name: "database",
  commands: {
    dev: "docker-compose up",
  },
})

const apiTask = task({
  name: "api",
  commands: {
    dev: "npm run dev",
    build: "npm run build",
  },
  dependencies: [dbTask],
})

const result = await pipeline([dbTask, apiTask]).run({
  command: "build",
  onTaskSkipped: (taskName, taskId, mode, reason) => {
    if (reason === "command-not-found") {
      console.log(`[${taskName}] skipped (no "${mode}" command)`)
    } else if (reason === "cache-hit") {
      console.log(`[${taskName}] skipped (cache hit)`)
    }
  },
})
```

---

### Strict Mode

In **strict mode**, missing commands cause the pipeline to fail. This is useful for CI and release pipelines.

```ts
const result = await pipeline([dbTask, apiTask]).run({
  command: "build",
  strict: true,
})

if (!result.ok) {
  console.error("Pipeline failed in strict mode:", result.error.message)
}
```

---

### Task-Level Skip Override

Tasks may explicitly allow skipping, even when strict mode is enabled.

```ts
const dbTask = task({
  name: "database",
  commands: {
    dev: "docker-compose up",
  },
  allowSkip: true,
})

const result = await pipeline([dbTask]).run({
  command: "build",
  strict: true,
})
```

---

## Caching

**builderman** supports task-level caching to skip expensive work when inputs and outputs haven't changed. This is useful for build-style tasks where you want to avoid re-running work when nothing has changed.

### Basic Usage

Enable caching by providing `cache` configuration in your command:

```ts
const buildTask = task({
  name: "build",
  commands: {
    build: {
      run: "tsc",
      cache: {
        inputs: ["src"],
        // outputs is optional; if omitted, only inputs are tracked
        outputs: ["dist"],
      },
    },
  },
})
```

When caching is enabled:

1. **First run**: The task executes normally and creates a snapshot of the input and output files
2. **Subsequent runs**: The task compares the current state with the cached snapshot
3. **Cache hit**: If inputs and outputs are unchanged, the task is **skipped** (no command execution)
4. **Cache miss**: If anything changed, the task runs and updates the cache

### Cache Inputs

Cache inputs can include:

- **File paths** (strings): Directories or files to track
- **Artifacts**: References to outputs from other tasks using `task.artifact("command")`
- **Input resolvers**: Special functions that resolve to cacheable inputs (e.g., package dependencies)

#### File Paths

```ts
const buildTask = task({
  name: "build",
  commands: {
    build: {
      run: "tsc",
      cache: {
        inputs: ["src", "package.json"],
        outputs: ["dist"],
      },
    },
  },
})
```

#### Artifacts

You can reference outputs from other tasks as cache inputs using `task.artifact("command")`. This creates an artifact dependency that tracks changes to the producing task's outputs.

```ts
const shared = task({
  name: "shared",
  cwd: "packages/shared",
  commands: {
    build: {
      run: "npm run build",
      cache: {
        inputs: ["src"],
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
      run: "npm run build",
      cache: {
        inputs: [
          "src",
          shared.artifact("build"), // Track changes to shared's build outputs
        ],
        outputs: ["dist"],
      },
    },
  },
})
```

When using artifacts:

- The artifact-producing task must have `cache.outputs` defined
- The artifact is included in the cache key, so changes to the artifact invalidate the cache
- The consuming task automatically depends on the producing task (execution dependency)

#### Input Resolvers

Input resolvers are functions that resolve to cacheable inputs. They're useful for tracking package dependencies and other dynamic inputs.

For example, the `@builderman/resolvers-pnpm` package provides a resolver for pnpm package dependencies:

```ts
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

The resolver automatically detects whether you're in a workspace or local package and tracks the appropriate `pnpm-lock.yaml` and package dependencies.

### How It Works

The cache system:

- Creates a snapshot of file metadata (modification time and size) for all files in the configured input and output paths
- For artifacts, tracks the artifact identifier from the producing task's cache
- For resolvers, includes the resolved input in the cache key
- Stores snapshots in `.builderman/cache/<version>/` relative to the main process's working directory
- Compares snapshots before running the task
- Writes the snapshot **after** successful task completion (ensuring outputs are captured)

### Path Resolution

- Paths may be **absolute** or **relative to the task's `cwd`**
- Directories are recursively scanned for all files
- Non-existent paths are treated as empty (no files)

### Cache Information in Statistics

When a task has cache configuration, its statistics include cache information:

```ts
const result = await pipeline([buildTask]).run()

const taskStats = result.stats.tasks[0]

if (taskStats.cache) {
  console.log("Cache checked:", taskStats.cache.checked)
  console.log("Cache hit:", taskStats.cache.hit)
  console.log("Cache file:", taskStats.cache.cacheFile)
  console.log("Inputs:", taskStats.cache.inputs)
  console.log("Outputs:", taskStats.cache.outputs)
}
```

### Cache Behavior

- **Cache failures never break execution** — if cache checking fails, the task runs normally
- **Cache is written after completion** — ensures outputs are captured correctly
- **Cache is per task and command** — each task-command combination has its own cache file
- **Cache directory is versioned** — stored under `v1/` to allow future cache format changes

### When to Use Caching

Caching is ideal for:

- Build tasks (TypeScript compilation, bundling, etc.)
- Code generation tasks
- Any expensive operation where inputs/outputs can be reliably tracked

Caching is **not** suitable for:

- Tasks that have side effects beyond file outputs
- Tasks that depend on external state (APIs, databases, etc.)
- Tasks where outputs are non-deterministic

---

## Execution Statistics

Every pipeline run returns detailed execution statistics.

### Pipeline Statistics

```ts
console.log(result.stats.status) // "success" | "failed" | "aborted"
console.log(result.stats.command) // Executed mode
console.log(result.stats.durationMs) // Total execution time
console.log(result.stats.summary.total)
console.log(result.stats.summary.completed)
console.log(result.stats.summary.failed)
console.log(result.stats.summary.skipped)
console.log(result.stats.summary.running)
```

---

### Task Statistics

Each task provides detailed per-task data:

```ts
for (const task of result.stats.tasks) {
  console.log(task.name, task.status)
  console.log(task.durationMs)

  if (task.status === "failed") {
    console.error(task.error?.message)
    console.error(task.exitCode)
  }

  if (task.teardown) {
    console.log("Teardown:", task.teardown.status)
  }

  // Cache information is available when the task has cache configuration
  if (task.cache) {
    console.log("Cache checked:", task.cache.checked)
    if (task.cache.hit !== undefined) {
      console.log("Cache hit:", task.cache.hit)
    }
  }

  // when using pipeline.toTask() to convert a pipeline into a task, the task will have subtasks
  if (task.subtasks) {
    for (const subtask of task.subtasks) {
      // ...
    }
  }
}
```

---

## Advanced Examples

### Monorepo Build Pipeline

Here's a comprehensive example showing how to build a complex monorepo pipeline with caching, artifacts, and pipeline composition:

```ts
import { task, pipeline } from "builderman"
import { pnpm } from "@builderman/resolvers-pnpm"

/**
 * Shared core module used by multiple packages
 */
const core = task({
  name: "core",
  cwd: "packages/core",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: ["src", pnpm.package()],
        outputs: ["dist"],
      },
    },
    dev: {
      run: "pnpm dev",
      readyWhen: (output) => output.includes("Watching for file changes"),
    },
    test: {
      run: "pnpm test",
      env: {
        NODE_ENV: "development",
      },
    },
  },
})

/**
 * Factory for related feature packages
 */
const createFeatureTask = (name: string) =>
  task({
    name,
    cwd: `packages/${name}`,
    commands: {
      build: {
        run: "pnpm build",
        cache: {
          inputs: ["src", core.artifact("build"), pnpm.package()],
          outputs: ["dist"],
        },
      },
      dev: {
        run: "pnpm dev",
        readyWhen: (output) => output.includes("Build complete"),
      },
    },
  })

const featureA = createFeatureTask("feature-a")
const featureB = createFeatureTask("feature-b")

/**
 * Compose related features into a single pipeline task
 */
const features = pipeline([featureA, featureB]).toTask({
  name: "features",
  dependencies: [core],
})

/**
 * Consumer package with command-level dependencies
 */
const integration = task({
  name: "integration",
  cwd: "packages/integration",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          core.artifact("build"),
          featureA.artifact("build"),
          featureB.artifact("build"),
          pnpm.package(),
        ],
        outputs: ["dist"],
      },
    },
    dev: {
      run: "pnpm dev",
      dependencies: [core, features],
    },
  },
})

/**
 * End-to-end test suites
 */
const smokeTests = task({
  name: "e2e:smoke",
  cwd: "tests/smoke",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          core.artifact("build"),
          integration.artifact("build"),
          pnpm.package(),
        ],
        outputs: ["dist"],
      },
    },
    test: "pnpm test",
  },
  dependencies: [core],
  env: {
    NODE_ENV: "development",
  },
})

const fullTests = task({
  name: "e2e:full",
  cwd: "tests/full",
  commands: {
    build: {
      run: "pnpm build",
      cache: {
        inputs: [
          "src",
          core.artifact("build"),
          integration.artifact("build"),
          pnpm.package(),
        ],
        outputs: ["dist"],
      },
    },
    test: "pnpm test",
  },
  // Conditional dependency based on environment
  dependencies: (process.env.CI ? [smokeTests] : []).concat(core),
  env: {
    NODE_ENV: "development",
  },
})

/**
 * Pipeline execution
 */
const command = process.argv[2]

const result = await pipeline([
  core,
  features,
  integration,
  smokeTests,
  fullTests,
]).run({
  command,
  onTaskBegin: (name) => console.log(`[start] ${name}`),
  onTaskSkipped: (name, _, __, reason) =>
    console.log(`[skip] ${name} (${reason})`),
  onTaskComplete: (name) => console.log(`[done] ${name}`),
})

console.log(result)
```

This example demonstrates:

- **Caching with artifacts**: Tasks reference outputs from other tasks using `task.artifact("command")`
- **Input resolvers**: Using `pnpm.package()` to track package dependencies
- **Pipeline composition**: Converting pipelines to tasks with `pipeline.toTask()`
- **Command-level dependencies**: Different commands can have different dependencies
- **Conditional dependencies**: Adjusting dependencies based on runtime conditions
- **Observability**: Using callbacks to track pipeline execution

---

## When Should I Use builderman?

**builderman** is a good fit when:

- You have interdependent tasks that must run in a well-defined order
- You run long-lived processes that need readiness detection (not just exit codes)
- Cleanup and teardown matter (containers, databases, servers, watchers)
- You want deterministic execution with structured results instead of log-scraping
- You need observable pipelines that behave the same locally and in CI
- You want to compose and reuse workflows, not just run scripts

It may be overkill if:

- Your workflow is a handful of linear npm scripts
- Tasks are fire-and-forget and don’t require cleanup
- You don’t need dependency graphs, cancellation, or failure propagation
