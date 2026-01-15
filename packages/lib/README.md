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
