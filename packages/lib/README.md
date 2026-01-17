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

const result = await pipeline([task1, task2]).run({
  // default command is "build" if process.NODE_ENV is "production", otherwise "dev".
  command: "deploy",
  onTaskBegin: (taskName) => {
    console.log(`[${taskName}] Starting...`)
  },
  onTaskComplete: (taskName) => {
    console.log(`[${taskName}] Complete!`)
  },
})

// Check result
if (!result.ok) {
  console.error("Pipeline failed:", result.error)
}

// Access detailed statistics
console.log(`Pipeline ${result.stats.status}`)
console.log(`Completed: ${result.stats.summary.completed}`)
console.log(`Failed: ${result.stats.summary.failed}`)
console.log(`Duration: ${result.stats.durationMs}ms`)
```

## Error Handling

The pipeline **never throws** - it always returns a `RunResult` with detailed statistics. Check the `ok` field to determine success or failure:

```ts
import { pipeline, PipelineError } from "builderman"

const result = await pipeline([task1, task2]).run()

if (!result.ok) {
  // Pipeline failed - check the error
  switch (result.error.code) {
    case PipelineError.Aborted:
      console.error("Pipeline was cancelled")
      break
    case PipelineError.TaskFailed:
      console.error(`Task failed: ${result.error.message}`)
      break
    case PipelineError.ProcessTerminated:
      console.error("Process was terminated")
      break
    case PipelineError.InvalidTask:
      console.error(`Invalid task configuration: ${result.error.message}`)
      break
    case PipelineError.InvalidSignal:
      console.error("Invalid abort signal")
      break
  }
}

// Stats are always available, even on failure
console.log(`Pipeline status: ${result.stats.status}`)
console.log(`Tasks completed: ${result.stats.summary.completed}`)
console.log(`Tasks failed: ${result.stats.summary.failed}`)
```

## Cancellation

You can cancel a running pipeline by providing an `AbortSignal`:

```ts
import { pipeline, PipelineError } from "builderman"

const abortController = new AbortController()

const runPromise = pipeline([task1, task2]).run({
  signal: abortController.signal,
})

// Cancel the pipeline after 5 seconds
setTimeout(() => {
  abortController.abort()
}, 5000)

const result = await runPromise

if (!result.ok && result.error.code === PipelineError.Aborted) {
  console.error("Pipeline was cancelled")
  // Check how many tasks were still running
  console.log(`Tasks still running: ${result.stats.summary.running}`)
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
const result = await pipeline([dbTask]).run({
  onTaskTeardown: (taskName) => {
    console.log(`[${taskName}] Starting teardown...`)
  },
  onTaskTeardownError: (taskName, error) => {
    console.error(`[${taskName}] Teardown failed: ${error.message}`)
    // error is a regular Error instance (not a PipelineError)
    // Teardown failures do not affect pipeline success/failure
  },
})

// Check teardown status in stats
const taskStats = Object.values(result.stats.tasks)[0]
if (taskStats.teardown) {
  console.log(`Teardown status: ${taskStats.teardown.status}`)
  if (taskStats.teardown.status === "failed") {
    console.error(`Teardown error: ${taskStats.teardown.error?.message}`)
  }
}
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
const result = await pipeline([db, api]).run()
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

const result = await pipeline([dbTask, apiTask]).run({
  command: "build",
  onTaskSkipped: (taskName, mode) => {
    console.log(`[${taskName}] skipped (no command for mode "${mode}")`)
  },
})

// Check skipped tasks in stats
console.log(`Skipped: ${result.stats.summary.skipped}`)
```

### Strict Mode

In strict mode, missing commands cause the pipeline to fail. Use this for CI/release pipelines where every task is expected to participate:

```ts
const result = await pipeline([dbTask, apiTask]).run({
  command: "build",
  strict: true, // Missing commands will cause pipeline to fail
})

if (!result.ok) {
  console.error("Pipeline failed in strict mode:", result.error.message)
}
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

const result = await pipeline([dbTask]).run({
  command: "build",
  strict: true, // Global strict mode
  // dbTask will still be skipped because allowSkip: true
})

// Task was skipped despite strict mode
console.log(`Skipped: ${result.stats.summary.skipped}`)
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
const result = await pipeline([outerTask]).run({ command: "build" })

if (result.stats.summary.skipped > 0) {
  console.log("Outer task was skipped because all inner tasks were skipped")
}
```

## Pipeline Composition

Build complex workflows by converting pipelines to tasks.

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

const result = await ci.run()
if (!result.ok) {
  console.error("CI pipeline failed:", result.error)
  // Check which stage failed
  for (const taskStats of Object.values(result.stats.tasks)) {
    if (taskStats.status === "failed") {
      console.error(`  ${taskStats.name} failed: ${taskStats.error?.message}`)
    }
  }
}
```

**Note:** When a pipeline is converted to a task, it becomes a single unit in the dependency graph. The nested pipeline will execute completely before any dependent tasks can start.

## Execution Statistics

The pipeline returns detailed statistics about the execution. The `RunResult` contains:

- `ok`: `true` if the pipeline succeeded, `false` if it failed or was aborted
- `error`: `null` if successful, otherwise a `PipelineError` instance
- `stats`: Detailed statistics about the pipeline execution

### Pipeline Statistics

```ts
const result = await pipeline([task1, task2]).run()

console.log(result.stats.status) // "success" | "failed" | "aborted"
console.log(result.stats.command) // "dev" | "build" | etc.
console.log(result.stats.durationMs) // Total execution time
console.log(result.stats.summary.total) // Total number of tasks
console.log(result.stats.summary.completed) // Number of completed tasks
console.log(result.stats.summary.failed) // Number of failed tasks
console.log(result.stats.summary.skipped) // Number of skipped tasks
console.log(result.stats.summary.running) // Number of tasks still running (useful when aborted)
```

### Task Statistics

Each task has detailed statistics available in `result.stats.tasks`:

```ts
const result = await pipeline([task1, task2]).run()

for (const [taskId, taskStats] of Object.entries(result.stats.tasks)) {
  console.log(`Task: ${taskStats.name}`)
  console.log(`Status: ${taskStats.status}`) // "pending" | "skipped" | "running" | "completed" | "failed" | "aborted"
  console.log(`Command: ${taskStats.command}`)
  console.log(`Duration: ${taskStats.durationMs}ms`)
  
  if (taskStats.status === "failed") {
    console.error(`Error: ${taskStats.error?.message}`)
    console.error(`Exit code: ${taskStats.exitCode}`)
    if (taskStats.signal) {
      console.error(`Terminated by: ${taskStats.signal}`)
    }
  }
  
  if (taskStats.teardown) {
    console.log(`Teardown status: ${taskStats.teardown.status}`)
    if (taskStats.teardown.status === "failed") {
      console.error(`Teardown error: ${taskStats.teardown.error?.message}`)
    }
  }
}
```

### Example: Checking Task Results

```ts
const result = await pipeline([buildTask, testTask, deployTask]).run()

if (!result.ok) {
  // Find which tasks failed
  const failedTasks = Object.values(result.stats.tasks).filter(
    (t) => t.status === "failed"
  )
  
  for (const task of failedTasks) {
    console.error(`${task.name} failed:`)
    console.error(`  Error: ${task.error?.message}`)
    console.error(`  Exit code: ${task.exitCode}`)
    console.error(`  Duration: ${task.durationMs}ms`)
  }
  
  // Check if any tasks were still running when pipeline was aborted
  if (result.stats.summary.running > 0) {
    console.warn(`${result.stats.summary.running} tasks were still running`)
  }
} else {
  console.log("✅ All tasks completed successfully!")
  console.log(`Total duration: ${result.stats.durationMs}ms`)
}
```
