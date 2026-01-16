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
  },
  cwd: "packages/consumer",
  dependencies: [task1],
})

await pipeline([task1, task2]).run({
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
