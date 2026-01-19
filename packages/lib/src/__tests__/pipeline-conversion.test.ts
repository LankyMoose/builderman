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

    // Verify execution order: build pipeline should complete before test starts
    // Note: pipeline-complete events fire when the scheduler is done, which may be
    // before individual task exit events due to async timing
    const buildPipelineCompleteIndex = executionOrder.indexOf(
      "pipeline-complete:build"
    )
    const testStartIndex = executionOrder.indexOf("start:test:unit")

    assert.ok(
      buildPipelineCompleteIndex !== -1,
      "build pipeline should complete"
    )
    assert.ok(testStartIndex !== -1, "test:unit should start")

    // Build pipeline should complete before test starts
    assert.ok(
      buildPipelineCompleteIndex < testStartIndex,
      `build pipeline should complete before test starts. Build completed at ${buildPipelineCompleteIndex}, test started at ${testStartIndex}. Order: ${executionOrder.join(
        ", "
      )}`
    )

    // Test pipeline should complete before deploy starts
    const testPipelineCompleteIndex = executionOrder.indexOf(
      "pipeline-complete:test"
    )
    const deployStartIndex = executionOrder.indexOf("start:deploy:upload")
    assert.ok(
      testPipelineCompleteIndex < deployStartIndex,
      `test pipeline should complete before deploy starts. Test completed at ${testPipelineCompleteIndex}, deploy started at ${deployStartIndex}. Order: ${executionOrder.join(
        ", "
      )}`
    )

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
