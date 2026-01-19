import assert from "node:assert"
import { describe, it, mock } from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { pipeline } from "../pipeline.js"
import { task } from "../task.js"
import { createMockSpawn } from "./helpers.js"

describe("environment variables", () => {
  it("passes env from pipeline.run() to spawned processes", async () => {
    let capturedEnv: Record<string, string> | undefined

    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      env: { TEST_VAR: "pipeline-value", ANOTHER_VAR: "another-value" },
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    assert.strictEqual(capturedEnv.TEST_VAR, "pipeline-value")
    assert.strictEqual(capturedEnv.ANOTHER_VAR, "another-value")
  })

  it("merges pipeline env with task env (task env overrides pipeline env)", async () => {
    let capturedEnv: Record<string, string> | undefined

    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      env: { TEST_VAR: "task-value", TASK_VAR: "task-only" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      env: { TEST_VAR: "pipeline-value", PIPELINE_VAR: "pipeline-only" },
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    // Task env should override pipeline env
    assert.strictEqual(capturedEnv.TEST_VAR, "task-value")
    // Both should be present
    assert.strictEqual(capturedEnv.PIPELINE_VAR, "pipeline-only")
    assert.strictEqual(capturedEnv.TASK_VAR, "task-only")
  })

  it("merges pipeline env with command env (command env overrides task and pipeline env)", async () => {
    let capturedEnv: Record<string, string> | undefined

    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo task1",
          env: { TEST_VAR: "command-value", COMMAND_VAR: "command-only" },
        },
        build: "echo task1",
      },
      env: { TEST_VAR: "task-value", TASK_VAR: "task-only" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      env: { TEST_VAR: "pipeline-value", PIPELINE_VAR: "pipeline-only" },
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    // Command env should override both task and pipeline env
    assert.strictEqual(capturedEnv.TEST_VAR, "command-value")
    // All should be present
    assert.strictEqual(capturedEnv.PIPELINE_VAR, "pipeline-only")
    assert.strictEqual(capturedEnv.TASK_VAR, "task-only")
    assert.strictEqual(capturedEnv.COMMAND_VAR, "command-only")
  })

  it("passes env from pipeline.toTask() to nested pipeline", async () => {
    let capturedEnv: Record<string, string> | undefined

    const innerTask = task({
      name: "inner",
      commands: { dev: "echo inner", build: "echo inner" },
    })

    const innerPipeline = pipeline([innerTask])
    const outerTask = innerPipeline.toTask({
      name: "outer",
      env: { NESTED_VAR: "nested-value", ANOTHER_VAR: "nested-another" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const outerPipeline = pipeline([outerTask])
    const result = await outerPipeline.run({
      spawn: mockSpawn as any,
      env: { OUTER_VAR: "outer-value" },
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    assert.strictEqual(capturedEnv.NESTED_VAR, "nested-value")
    assert.strictEqual(capturedEnv.ANOTHER_VAR, "nested-another")
    assert.strictEqual(capturedEnv.OUTER_VAR, "outer-value")
  })

  it("passes custom command to nested pipeline", async () => {
    const executedCommands: string[] = []

    // Create a nested pipeline with tasks that have different commands
    const nestedTask1 = task({
      name: "nested:task1",
      commands: {
        dev: "echo dev:task1",
        build: "echo build:task1",
        test: "echo test:task1",
      },
    })
    const nestedTask2 = task({
      name: "nested:task2",
      commands: {
        dev: "echo dev:task2",
        build: "echo build:task2",
        test: "echo test:task2",
      },
      dependencies: [nestedTask1],
    })
    const nested = pipeline([nestedTask1, nestedTask2])

    // Create parent pipeline with nested pipeline as a task
    const nestedTask = nested.toTask({ name: "nested" })
    const parent = pipeline([nestedTask])

    const mockSpawn = createMockSpawn({
      commandHandler: (cmd: string, args: string[], process: ChildProcess) => {
        executedCommands.push([cmd, ...args].join(" "))
        // Emit exit event so the process completes
        setImmediate(() => {
          process.emit("exit", 0)
        })
      },
    })

    // Run parent pipeline with custom "test" command
    const result = await parent.run({
      spawn: mockSpawn as any,
      command: "test",
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.stats.status, "success")

    // Verify that nested pipeline tasks executed with "test" command
    // Should see "test:task1" and "test:task2", not "dev" or "build"
    assert.ok(
      executedCommands.some((cmd) => cmd.includes("test:task1")),
      "Nested task1 should execute with 'test' command"
    )
    assert.ok(
      executedCommands.some((cmd) => cmd.includes("test:task2")),
      "Nested task2 should execute with 'test' command"
    )
    // Verify dev commands were NOT executed
    assert.ok(
      !executedCommands.some((cmd) => cmd.includes("dev:task1")),
      "Nested task1 should NOT execute with 'dev' command"
    )
    assert.ok(
      !executedCommands.some((cmd) => cmd.includes("dev:task2")),
      "Nested task2 should NOT execute with 'dev' command"
    )
    // Verify build commands were NOT executed
    assert.ok(
      !executedCommands.some((cmd) => cmd.includes("build:task1")),
      "Nested task1 should NOT execute with 'build' command"
    )
    assert.ok(
      !executedCommands.some((cmd) => cmd.includes("build:task2")),
      "Nested task2 should NOT execute with 'build' command"
    )

    // Verify task stats show the correct command
    const nestedTaskStats = result.stats.tasks.find(
      (t) => t.name === "nested"
    )!
    assert.strictEqual(nestedTaskStats.command, "test")
  })

  it("merges pipeline env with nested pipeline task env (nested task env overrides)", async () => {
    let capturedEnv: Record<string, string> | undefined

    const innerTask = task({
      name: "inner",
      commands: { dev: "echo inner", build: "echo inner" },
    })

    const innerPipeline = pipeline([innerTask])
    const outerTask = innerPipeline.toTask({
      name: "outer",
      env: { SHARED_VAR: "nested-value", NESTED_ONLY: "nested-only" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const outerPipeline = pipeline([outerTask])
    const result = await outerPipeline.run({
      spawn: mockSpawn as any,
      env: { SHARED_VAR: "outer-value", OUTER_ONLY: "outer-only" },
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    // Nested task env should override outer pipeline env
    assert.strictEqual(capturedEnv.SHARED_VAR, "nested-value")
    // Both should be present
    assert.strictEqual(capturedEnv.OUTER_ONLY, "outer-only")
    assert.strictEqual(capturedEnv.NESTED_ONLY, "nested-only")
  })

  it("preserves process.env when no custom env is provided", async () => {
    let capturedEnv: Record<string, string> | undefined

    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
    })

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = [], options: any) => {
      capturedEnv = options?.env
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any
      setImmediate(() => {
        mockProcess.emit("exit", 0)
      })
      return mockProcess
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
    })

    assert.strictEqual(result.ok, true)
    assert.ok(capturedEnv)
    // Should include process.env values
    assert.ok(capturedEnv.PATH !== undefined || capturedEnv.Path !== undefined)
  })
})
