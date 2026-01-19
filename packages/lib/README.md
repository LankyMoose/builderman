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
> - [Execution Statistics](#execution-statistics)
>   - [Pipeline Statistics](#pipeline-statistics)
>   - [Task Statistics](#task-statistics)
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
  commands: { build: "tsc" },
  cwd: "packages/my-package", // Optional: defaults to "."
})

const test = task({
  name: "test",
  commands: { build: "npm test" },
  dependencies: [build],
  cwd: "packages/my-package",
})

const result = await pipeline([build, test]).run({
  command: "build",
})

if (!result.ok) {
  console.error("Pipeline failed:", result.error.message)
}
```

This defines a simple dependency graph where `test` runs only after `build` completes successfully.

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

const libTask = task({
  name: "lib:build",
  commands: {
    build: "tsc",
    dev: {
      run: "tsc --watch",
      readyWhen: (stdout) => stdout.includes("Watching for file changes."),
    },
  },
  cwd: "packages/lib",
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
  - `readyWhen`: a predicate that marks the task as ready
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
const apiTask = task({
  name: "api",
  commands: {
    dev: {
      run: "npm run dev",
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
const apiTask = task({
  name: "api",
  commands: {
    dev: "npm run dev",
    build: "npm run build",
  },
  env: {
    API_URL: "http://localhost:3000",
    LOG_LEVEL: "debug",
  },
})
```

#### Pipeline-Level Environment Variables

```ts
const result = await pipeline([apiTask]).run({
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

```ts
const consumerTask = task({
  name: "consumer:dev",
  commands: {
    build: "npm run build",
    dev: "npm run dev",
  },
  cwd: "packages/consumer",
  dependencies: [libTask],
})
```

---

### Pipelines

A **pipeline** executes a set of tasks according to their dependency graph.

```ts
import { pipeline } from "builderman"

const result = await pipeline([libTask, consumerTask]).run({
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
const build = pipeline([
  /* ... */
])
const test = pipeline([
  /* ... */
])
const deploy = pipeline([
  /* ... */
])

const buildTask = build.toTask({ name: "build" })
const testTask = test.toTask({
  name: "test",
  dependencies: [buildTask],
  env: { TEST_ENV: "test-value" }, // Optional: env for nested pipeline
})
const deployTask = deploy.toTask({ name: "deploy", dependencies: [testTask] })

const ci = pipeline([buildTask, testTask, deployTask])
const result = await ci.run()
```

When a pipeline is converted to a task, it becomes a **single node** in the dependency graph. The nested pipeline must fully complete before dependents can start.

---

## Error Handling Guarantees

**builderman pipelines never throw.**

All failures — including task errors, invalid configuration, cancellation, and process termination — are reported through a structured `RunResult`.

```ts
import { pipeline, PipelineError } from "builderman"

const result = await pipeline([libTask, consumerTask]).run()

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

const runPromise = pipeline([libTask, consumerTask]).run({
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

### How It Works

The cache system:

- Creates a snapshot of file metadata (modification time and size) for all files in the configured input and output paths
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

## When Should I Use builderman?

**builderman** is a good fit when:

- You have dependent tasks that must run in a strict order
- You run long-lived dev processes that need readiness detection
- Cleanup matters (databases, containers, servers)
- You want structured results instead of log-scraping

It may be overkill if:

- You only need a few linear npm scripts
- You do not need dependency graphs or teardown guarantees
