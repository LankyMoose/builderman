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
    dev: "tsc --watch",
    build: "tsc",
  },
  cwd: "packages/lib",
  isReady: (stdout) => {
    // mark this this task as ready when the process is watching for file changes
    return stdout.includes("Watching for file changes.")
  },
})

const task2 = task({
  name: "consumer:dev",
  commands: {
    dev: "npm run dev",
    build: "npm run build",
  },
  cwd: "packages/consumer",
  dependencies: [task1],
})

await pipeline([task1, task2]).run({
  onTaskError: (taskName, error) => {
    console.error(`[${taskName}] Error: ${error.message}`)
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

## Pipeline Composition

Build complex workflows by composing tasks and pipelines together.

### Task Chaining

Chain tasks together using `andThen()` to create a pipeline that will run the tasks in order:

```ts
import { task, pipeline } from "builderman"

const build = task({
  name: "compile",
  commands: { dev: "tsc --watch", build: "tsc" },
  cwd: "packages/lib",
}).andThen({
  name: "bundle",
  commands: { dev: "rollup --watch", build: "rollup" },
  cwd: "packages/lib",
})

await build.run()
```

### Pipeline Chaining

Chain pipelines together using `andThen()`:

```ts
const build = pipeline([
  task({ name: "compile", commands: { dev: "tsc", build: "tsc" }, cwd: "." }),
])

const ci = build
  .andThen({
    name: "test",
    commands: { dev: "vitest watch", build: "vitest run" },
    cwd: ".",
  })
  .andThen(
    anotherPipeline.toTask({
      //...
    })
  )

await ci.run()
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
