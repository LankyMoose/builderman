import assert from "node:assert"
import { describe, it } from "node:test"

import { pipeline } from "../pipeline.js"
import { task } from "../task.js"
import { createMockSpawn } from "./helpers.js"

describe("pipeline <-> task conversion", () => {
  it("converts pipelines to tasks", async () => {
    const executionOrder: string[] = []

    // Mock spawn to track execution
    const mockSpawn = createMockSpawn()

    // Create individual pipelines with mock spawn
    const buildTask1 = task({
      name: "build:compile",
      commands: { dev: "echo build:compile", build: "echo build:compile" },
    })
    const buildTask2 = task({
      name: "build:bundle",
      commands: { dev: "echo build:bundle", build: "echo build:bundle" },
      dependencies: [buildTask1],
    })
    const build = pipeline([buildTask1, buildTask2])

    const testTask1 = task({
      name: "test:unit",
      commands: { dev: "echo test:unit", build: "echo test:unit" },
    })
    const test = pipeline([testTask1])

    const deployTask1 = task({
      name: "deploy:upload",
      commands: { dev: "echo deploy:upload", build: "echo deploy:upload" },
    })
    const deploy = pipeline([deployTask1])

    // Compose pipelines
    const buildTask = build.toTask({ name: "build" })
    const testTask = test.toTask({
      name: "test",
      dependencies: [buildTask],
    })
    const deployTask = deploy.toTask({
      name: "deploy",
      dependencies: [testTask],
    })

    const ci = pipeline([buildTask, testTask, deployTask])

    const result = await ci.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        // For nested pipelines, name format is "pipelineTask:nestedTask" (e.g., "build:build:compile")
        // Extract the nested task name (everything after first colon)
        const parts = name.split(":")
        const nestedTaskName =
          parts.length > 1 ? parts.slice(1).join(":") : name
        executionOrder.push(`start:${nestedTaskName}`)
      },
      onTaskComplete: (name) => {
        executionOrder.push(`pipeline-complete:${name}`)
      },
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.stats.status, "success")

    // Note: with pipeline-to-task readiness, dependents may begin once all inner tasks
    // are ready/complete (before the outer pipeline task itself reports completion).
    // So we only assert that expected tasks ran, not strict ordering across pipeline tasks.

    // Verify all tasks executed
    assert.ok(
      executionOrder.includes("start:build:compile"),
      "build:compile should start"
    )
    assert.ok(
      executionOrder.includes("start:build:bundle"),
      "build:bundle should start"
    )
    assert.ok(
      executionOrder.includes("start:test:unit"),
      "test:unit should start"
    )
    assert.ok(
      executionOrder.includes("start:deploy:upload"),
      "deploy:upload should start"
    )
  })

  it("unblocks dependents when all inner tasks are ready (pipeline.toTask in dev/watch)", async () => {
    const executionOrder: string[] = []

    const inner1 = task({
      name: "inner-1",
      commands: {
        dev: {
          run: "run inner-1",
          readyWhen: (out) => out.includes("INNER_1_READY"),
        },
        build: "run inner-1",
      },
    })

    const inner2 = task({
      name: "inner-2",
      commands: {
        dev: {
          run: "run inner-2",
          readyWhen: (out) => out.includes("INNER_2_READY"),
        },
        build: "run inner-2",
      },
    })

    const nested = pipeline([inner1, inner2]).toTask({ name: "nested" })

    const dependent = task({
      name: "dependent",
      commands: { dev: "run dependent", build: "run dependent" },
      dependencies: [nested],
    })

    const controller = new AbortController()

    const mockSpawn = createMockSpawn({
      commandHandler: (command, proc) => {
        if (command.includes("inner-1")) {
          // Simulate a watch process that becomes ready but never exits
          setImmediate(() => {
            proc.stdout?.emit("data", Buffer.from("INNER_1_READY\n"))
          })
          return
        }
        if (command.includes("inner-2")) {
          setImmediate(() => {
            proc.stdout?.emit("data", Buffer.from("INNER_2_READY\n"))
          })
          return
        }
        if (command.includes("dependent")) {
          // As soon as the dependent starts, abort the run so the test doesn't hang
          setImmediate(() => {
            controller.abort()
            proc.emit("exit", 0)
          })
          return
        }
      },
    })

    const result = await pipeline([nested, dependent]).run({
      spawn: mockSpawn as any,
      signal: controller.signal,
      onTaskBegin: (name) => executionOrder.push(`begin:${name}`),
      onTaskReady: (name) => executionOrder.push(`ready:${name}`),
      onTaskComplete: (name) => executionOrder.push(`complete:${name}`),
      onTaskSkipped: (name, _id, mode) => executionOrder.push(`skip:${name}:${mode}`),
    })

    // We abort intentionally; the important part is that the dependent started.
    assert.strictEqual(result.ok, false)
    assert.ok(
      executionOrder.includes("begin:dependent"),
      `dependent should have started after nested became ready. Order: ${executionOrder.join(
        ", "
      )}`
    )
  })

  it("throws error when using unconverted pipeline as dependency", () => {
    const build = pipeline([
      task({
        name: "build",
        commands: { dev: "echo build", build: "echo build" },
      }),
    ])

    const test = pipeline([
      task({
        name: "test",
        commands: { dev: "echo test", build: "echo test" },
      }),
    ])

    // Try to use build pipeline as dependency without converting it first
    assert.throws(() => {
      test.toTask({
        name: "test",
        dependencies: [
          // @ts-expect-error - build is a pipeline
          build,
        ],
      })
    }, /Invalid dependency/)
  })
})
