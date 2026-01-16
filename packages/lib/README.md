# **builderman**

#### _A simple task runner for building and developing projects._

<br />

## Installation

```bash
npm install builderman
```

## Usage

```ts
import { task, pipeline } from "builderman"

const task1 = task({
  name: "lib:build",
  commands: {
    build: "tsc",
    dev: {
      run: "tsc --watch",
      readyWhen: (stdout) => {
        // mark this task as ready when the process is watching for file changes
        return stdout.includes("Watching for file changes.")
      },
    },
  },
  cwd: "packages/lib",
})

const task2 = task({
  name: "consumer:dev",
  commands: {
    build: "npm run build",
    dev: "npm run dev",
    deploy: "npm run deploy",
  },
  cwd: "packages/consumer",
  dependencies: [task1],
})

await pipeline([task1, task2]).run({
  // default command is "build" if process.NODE_ENV is "production", otherwise "dev".
  command: "deploy",
  onTaskBegin: (taskName) => {
    console.log(`[${taskName}] Starting...`)
  },
  onTaskComplete: (taskName) => {
    console.log(`[${taskName}] Complete!`)
  },
  onPipelineComplete: () => {
    console.log("All tasks complete! 🎉")
  },
  onPipelineError: (error) => {
    console.error(`Pipeline error: ${error.message}`)
  },
})
```

## Error Handling

Pipeline errors are provided as `PipelineError` instances with error codes for easier handling:

```ts
import { pipeline, PipelineError } from "builderman"

await pipeline([task1, task2]).run({
  onPipelineError: (error) => {
    switch (error.code) {
      case PipelineError.Aborted:
        console.error("Pipeline was cancelled")
        break
      case PipelineError.TaskFailed:
        console.error(`Task failed: ${error.message}`)
        break
      case PipelineError.ProcessTerminated:
        console.error("Process was terminated")
        break
      case PipelineError.InvalidTask:
        console.error(`Invalid task configuration: ${error.message}`)
        break
      case PipelineError.InvalidSignal:
        console.error("Invalid abort signal")
        break
    }
  },
})
```

## Cancellation

You can cancel a running pipeline by providing an `AbortSignal`:

```ts
import { pipeline, PipelineError } from "builderman"

const abortController = new AbortController()

const runPromise = pipeline([task1, task2]).run({
  signal: abortController.signal,
  onPipelineError: (error) => {
    if (error.code === PipelineError.Aborted) {
      console.error("Pipeline was cancelled")
    }
  },
})

// Cancel the pipeline after 5 seconds
setTimeout(() => {
  abortController.abort()
}, 5000)

try {
  await runPromise
} catch (error) {
  if (error instanceof PipelineError && error.code === PipelineError.Aborted) {
    // Pipeline was cancelled
  }
}
```

## Teardown

Tasks can specify teardown commands that run automatically when the task completes or fails. Teardowns are executed in reverse dependency order (dependents before dependencies) to ensure proper cleanup.

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
  cwd: ".",
})
```

### Teardown Callbacks

You can monitor teardown execution with callbacks. Note that teardown failures do not cause the pipeline to fail - they are fire-and-forget cleanup operations:

```ts
await pipeline([dbTask]).run({
  onTaskTeardown: (taskName) => {
    console.log(`[${taskName}] Starting teardown...`)
  },
  onTaskTeardownError: (taskName, error) => {
    console.error(`[${taskName}] Teardown failed: ${error.message}`)
    // error is a regular Error instance (not a PipelineError)
    // Teardown failures do not affect pipeline success/failure
  },
})
```

### Teardown Execution Rules

Teardowns run when:

- ✅ The command entered the running state (regardless of success or failure)
- ✅ The pipeline completes successfully
- ✅ The pipeline fails after tasks have started

Teardowns do **not** run when:

- ❌ The task was skipped (no command for the current mode)
- ❌ The task failed before starting (spawn error)
- ❌ The pipeline never began execution

### Reverse Dependency Order

Teardowns execute in reverse dependency order to ensure dependents are cleaned up before their dependencies:

```ts
const db = task({
  name: "db",
  commands: {
    dev: { run: "docker-compose up", teardown: "docker-compose down" },
    build: "echo build",
  },
  cwd: ".",
})

const api = task({
  name: "api",
  commands: {
    dev: { run: "npm run dev", teardown: "echo stopping api" },
    build: "echo build",
  },
  cwd: ".",
  dependencies: [db], // api depends on db
})

// Teardown order: api first, then db
await pipeline([db, api]).run()
```

## Skipping Tasks

Tasks can be automatically skipped when they don't have a command for the current mode. This is useful for multi-mode pipelines where some tasks are only relevant in certain contexts.

### Default Behavior

If a task has no command for the current mode, it is **skipped**:

- ✅ The task participates in the dependency graph
- ✅ The task resolves immediately (satisfies dependencies)
- ✅ Dependents are unblocked
- ❌ No command is executed
- ❌ No teardown is registered
- ❌ No readiness is waited for

```ts
const dbTask = task({
  name: "database",
  commands: {
    dev: "docker-compose up",
    // No build command - will be skipped in build mode
  },
  cwd: ".",
})

const apiTask = task({
  name: "api",
  commands: {
    dev: "npm run dev",
    build: "npm run build",
  },
  cwd: ".",
  dependencies: [dbTask], // dbTask will be skipped, but apiTask will still run
})

await pipeline([dbTask, apiTask]).run({
  command: "build",
  onTaskSkipped: (taskName, mode) => {
    console.log(`[${taskName}] skipped (no command for mode "${mode}")`)
  },
})
```

### Strict Mode

In strict mode, missing commands cause the pipeline to fail. Use this for CI/release pipelines where every task is expected to participate:

```ts
await pipeline([dbTask, apiTask]).run({
  command: "build",
  strict: true, // Missing commands will cause pipeline to fail
})
```

### Task-Level Override

Even with global strict mode, you can explicitly allow a task to be skipped:

```ts
const dbTask = task({
  name: "database",
  commands: {
    dev: "docker-compose up",
    // No build command, but explicitly allowed to skip
  },
  cwd: ".",
  allowSkip: true, // Explicitly allow skipping even in strict mode
})

await pipeline([dbTask]).run({
  command: "build",
  strict: true, // Global strict mode
  // dbTask will still be skipped because allowSkip: true
})
```

### Nested Pipeline Behavior

When a pipeline is converted to a task, skip behavior is preserved:

- If **all** inner tasks are skipped → outer task is skipped
- If **some** run, some skip → outer task is completed
- If **any** fail → outer task fails

```ts
const innerPipeline = pipeline([
  task({ name: "inner1", commands: { dev: "..." }, cwd: "." }),
  task({ name: "inner2", commands: { dev: "..." }, cwd: "." }),
])

const outerTask = innerPipeline.toTask({ name: "outer" })

// If all inner tasks are skipped in build mode, outer task is also skipped
await pipeline([outerTask]).run({ command: "build" })
```

## Pipeline Composition

Build complex workflows by composing tasks and pipelines together.

### Task Chaining

Chain tasks together using `andThen()` to create a pipeline that will run the tasks in order, automatically adding the previous task as a dependency:

```ts
import { task } from "builderman"

const build = task({
  name: "compile",
  commands: {
    build: "tsc",
    dev: {
      run: "tsc --watch",
      readyWhen: (output) => output.includes("Watching for file changes."),
    },
  },
  cwd: "packages/lib",
}).andThen({
  name: "bundle",
  commands: {
    build: "rollup",
    dev: {
      run: "rollup --watch",
      readyWhen: (output) => output.includes("Watching for file changes."),
    },
  },
  cwd: "packages/lib",
})

await build.run()
```

### Composing Pipelines as Tasks

Convert pipelines to tasks and compose them with explicit dependencies:

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

// Convert to tasks first
const buildTask = build.toTask({ name: "build" })
const testTask = test.toTask({ name: "test", dependencies: [buildTask] })
const deployTask = deploy.toTask({ name: "deploy", dependencies: [testTask] })

// Compose into final pipeline
const ci = pipeline([buildTask, testTask, deployTask])

await ci.run()
```

**Note:** When a pipeline is converted to a task, it becomes a single unit in the dependency graph. The nested pipeline will execute completely before any dependent tasks can start.
