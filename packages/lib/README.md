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
