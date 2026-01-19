import assert from "node:assert"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { PipelineError } from "../errors.js"
import { pipeline } from "../pipeline.js"
import { task } from "../task.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const scriptsDir = path.resolve(__dirname, "scripts")

const nodeCommand = (scriptName: string): string =>
  `${process.execPath} ${path.join(scriptsDir, scriptName)}`

describe("pipeline (real processes)", () => {
  it("runs a real script successfully", async () => {
    const successTask = task({
      name: "success-script",
      commands: {
        dev: nodeCommand("success.js"),
        build: nodeCommand("success.js"),
      },
    })

    const result = await pipeline([successTask]).run({ command: "dev" })

    if (!result.ok) {
      // Helpful when debugging real-process behavior
      console.error("success-script error", result.error)
    }
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.stats.status, "success")
    const taskStats = result.stats.tasks[0]
    assert.strictEqual(taskStats.status, "completed")
    assert.strictEqual(taskStats.exitCode, 0)
  })

  it("fails when a real script exits non-zero", async () => {
    const failureTask = task({
      name: "failure-script",
      commands: {
        dev: nodeCommand("failure.js"),
        build: nodeCommand("failure.js"),
      },
    })

    const result = await pipeline([failureTask]).run({ command: "dev" })

    if (result.ok) {
      console.error("failure-script unexpectedly succeeded", result.stats)
    }
    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.TaskFailed)
    const taskStats = result.stats.tasks[0]
    assert.strictEqual(taskStats.status, "failed")
    assert.strictEqual(taskStats.exitCode, 1)
  })

  it("starts dependents only after readyWhen matches real process output", async () => {
    const events: string[] = []

    const readyTask = task({
      name: "ready-script",
      commands: {
        dev: {
          run: nodeCommand("ready.js"),
          readyWhen: (stdout) => stdout.includes("READY"),
        },
        build: {
          run: nodeCommand("ready.js"),
          readyWhen: (stdout) => stdout.includes("READY"),
        },
      },
    })

    const afterReadyTask = task({
      name: "after-ready",
      commands: {
        dev: nodeCommand("success.js"),
        build: nodeCommand("success.js"),
      },
      dependencies: [readyTask],
    })

    const result = await pipeline([readyTask, afterReadyTask]).run({
      command: "dev",
      onTaskBegin: (name) => events.push(`begin:${name}`),
      onTaskReady: (name) => events.push(`ready:${name}`),
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.stats.status, "success")

    assert.deepStrictEqual(events, [
      "begin:ready-script",
      "ready:ready-script",
      "begin:after-ready",
    ])
  })

  it("aborts a real long-running script when the AbortSignal is triggered", async () => {
    const abortController = new AbortController()

    const longRunningTask = task({
      name: "long-running-script",
      commands: {
        dev: nodeCommand("long-running.js"),
        build: nodeCommand("long-running.js"),
      },
    })

    const result = await pipeline([longRunningTask]).run({
      command: "dev",
      signal: abortController.signal,
      // Abort shortly after the task starts (give it a moment to spawn)
      onTaskBegin: (name) => {
        if (name === "long-running-script") {
          setTimeout(() => {
            console.log("ABORTING LONG-RUNNING SCRIPT")
            abortController.abort()
          }, 250)
        }
      },
    })

    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.Aborted)
    assert.strictEqual(result.stats.status, "aborted")

    const taskStats = result.stats.tasks[0]
    // Task should have started and then been aborted/failed due to cancellation
    assert.ok(
      taskStats.status === "aborted" || taskStats.status === "failed",
      `Expected aborted or failed status, got ${taskStats.status}`
    )
    assert.ok(taskStats.startedAt !== undefined)
    assert.ok(taskStats.finishedAt !== undefined)
  })
})
