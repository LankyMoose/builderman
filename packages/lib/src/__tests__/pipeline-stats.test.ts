import assert from "node:assert"
import { describe, it, mock } from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { pipeline } from "../pipeline.js"
import { PipelineError } from "../errors.js"
import { task } from "../task.js"
import { createMockSpawn } from "./helpers.js"

describe("stats field validation", () => {
  describe("successful pipeline", () => {
    it("includes all required PipelineStats fields", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.error, null)

      // Verify all PipelineStats fields
      const stats = result.stats
      assert.strictEqual(typeof stats.command, "string")
      assert.strictEqual(typeof stats.startedAt, "number")
      assert.strictEqual(typeof stats.finishedAt, "number")
      assert.strictEqual(typeof stats.durationMs, "number")
      assert.ok(["success", "failed", "aborted"].includes(stats.status))
      assert.ok(typeof stats.tasks === "object")
      assert.ok(stats.tasks !== null)

      // Verify summary fields
      assert.strictEqual(typeof stats.summary.total, "number")
      assert.strictEqual(typeof stats.summary.completed, "number")
      assert.strictEqual(typeof stats.summary.failed, "number")
      assert.strictEqual(typeof stats.summary.skipped, "number")
      assert.strictEqual(typeof stats.summary.running, "number")

      // Verify timing fields are reasonable
      assert.ok(stats.startedAt > 0)
      assert.ok(stats.finishedAt >= stats.startedAt)
      assert.ok(stats.durationMs >= 0)
    })

    it("includes all expected TaskStats fields for completed task", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = result.stats.tasks[0]

      // Required fields
      assert.strictEqual(typeof taskStats.id, "string")
      assert.strictEqual(typeof taskStats.name, "string")
      assert.strictEqual(taskStats.status, "completed")
      assert.ok(Array.isArray(taskStats.dependencies))
      assert.ok(Array.isArray(taskStats.dependents))

      // Expected fields for completed task
      assert.strictEqual(typeof taskStats.command, "string")
      assert.strictEqual(typeof taskStats.startedAt, "number")
      assert.strictEqual(typeof taskStats.finishedAt, "number")
      assert.strictEqual(typeof taskStats.durationMs, "number")
      assert.strictEqual(typeof taskStats.exitCode, "number")
      assert.strictEqual(taskStats.exitCode, 0)

      // Fields that should NOT be present for successful task
      assert.strictEqual(taskStats.signal, undefined)
      assert.strictEqual(taskStats.error, undefined)

      // Verify timing - these should be defined for completed tasks
      assert.ok(taskStats.startedAt !== undefined)
      assert.ok(taskStats.finishedAt !== undefined)
      assert.ok(taskStats.durationMs !== undefined)
      if (
        taskStats.startedAt !== undefined &&
        taskStats.finishedAt !== undefined &&
        taskStats.durationMs !== undefined
      ) {
        assert.ok(taskStats.startedAt > 0)
        assert.ok(taskStats.finishedAt >= taskStats.startedAt)
        assert.ok(taskStats.durationMs >= 0)
      }
    })

    it("includes teardown status when task has teardown", async () => {
      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          build: "echo task1",
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = result.stats.tasks[0]

      assert.ok(taskStats.teardown !== undefined)
      assert.ok(
        ["not-run", "completed", "failed"].includes(taskStats.teardown!.status)
      )
      assert.strictEqual(taskStats.teardown!.status, "completed")
      assert.strictEqual(taskStats.teardown!.error, undefined)
    })
  })

  describe("failed pipeline", () => {
    it("includes all required fields when task fails", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })

      const mockSpawn = createMockSpawn({ exitCode: 1 })
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      assert.strictEqual(result.ok, false)
      assert.ok(result.error instanceof PipelineError)

      // Verify PipelineStats
      assert.strictEqual(result.stats.status, "failed")
      assert.strictEqual(result.stats.summary.failed, 1)
      assert.strictEqual(result.stats.summary.completed, 0)

      // Verify TaskStats for failed task
      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "failed")
      assert.ok(taskStats.error instanceof Error)
      assert.strictEqual(typeof taskStats.exitCode, "number")
      assert.strictEqual(taskStats.exitCode, 1)
      assert.strictEqual(typeof taskStats.startedAt, "number")
      assert.strictEqual(typeof taskStats.finishedAt, "number")
      assert.strictEqual(typeof taskStats.durationMs, "number")
    })

    it("includes error field when task fails before starting", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
        cwd: "./nonexistent-directory",
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      assert.strictEqual(result.ok, false)

      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "failed")
      assert.ok(taskStats.error instanceof Error)
      assert.strictEqual(typeof taskStats.command, "string")
      // Task failed before starting, so no execution timing (but finishedAt is set when error occurs)
      assert.strictEqual(taskStats.startedAt, undefined)
      assert.ok(taskStats.finishedAt !== undefined) // Set when error occurs
      assert.strictEqual(taskStats.durationMs, 0) // Duration is 0 for pre-start failures
      assert.strictEqual(taskStats.exitCode, undefined)
    })

    it("includes signal field when task is terminated by signal", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "sleep 1", build: "sleep 1" },
      })

      const mockSpawn = mock.fn((_cmd: string, _args: string[] = []) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        // Simulate termination by signal
        setImmediate(() => {
          mockProcess.emit("exit", null, "SIGTERM")
        })

        return mockProcess
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      assert.strictEqual(result.ok, false)

      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "failed")
      assert.strictEqual(taskStats.signal, "SIGTERM")
      assert.strictEqual(taskStats.exitCode, undefined) // null exit code when terminated by signal
      assert.ok(taskStats.error instanceof Error)
    })
  })

  describe("aborted pipeline", () => {
    it("includes running count in summary when pipeline is aborted", async () => {
      const abortController = new AbortController()
      const task1 = task({
        name: "task1",
        commands: { dev: "sleep 1", build: "sleep 1" },
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "sleep 1", build: "sleep 1" },
        dependencies: [task1],
      })

      const mockSpawn = mock.fn((_cmd: string, _args: string[] = []) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        // Abort after a short delay
        setTimeout(() => {
          abortController.abort()
        }, 10)

        // Don't auto-exit - will be killed
        return mockProcess
      })

      const pipe = pipeline([task1, task2])
      const result = await pipe.run({
        spawn: mockSpawn as any,
        signal: abortController.signal,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.stats.status, "aborted")

      // Verify summary fields are all present and are numbers
      assert.strictEqual(typeof result.stats.summary.total, "number")
      assert.strictEqual(typeof result.stats.summary.completed, "number")
      assert.strictEqual(typeof result.stats.summary.failed, "number")
      assert.strictEqual(typeof result.stats.summary.skipped, "number")
      assert.strictEqual(typeof result.stats.summary.running, "number")

      // When aborted, the running count tracks tasks that were still running
      // Tasks that were aborted may be marked as "aborted" status (not counted in summary)
      // or "failed" status. The important thing is that all summary fields are present.
      assert.ok(result.stats.summary.running >= 0)
      assert.ok(result.stats.summary.total >= 0)

      // Verify that tasks exist and have proper status
      const taskStats = result.stats.tasks
      assert.ok(taskStats.length > 0)
      // At least one task should have been affected (aborted or failed status)
      const affectedTasks = taskStats.filter(
        (t) => t.status === "aborted" || t.status === "failed"
      )
      assert.ok(
        affectedTasks.length > 0 || result.stats.summary.running > 0,
        `At least one task should be affected. Summary: ${JSON.stringify(
          result.stats.summary
        )}, Task statuses: ${taskStats.map((t) => t.status).join(", ")}`
      )
    })

    it("marks running tasks as aborted with proper fields", async () => {
      const abortController = new AbortController()
      const task1 = task({
        name: "task1",
        commands: { dev: "sleep 1", build: "sleep 1" },
      })

      const mockSpawn = mock.fn((_cmd: string, _args: string[] = []) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        setTimeout(() => {
          abortController.abort()
        }, 10)

        return mockProcess
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({
        spawn: mockSpawn as any,
        signal: abortController.signal,
      })

      const taskStats = result.stats.tasks[0]
      assert.ok(["aborted", "failed"].includes(taskStats.status))
      assert.ok(
        taskStats.startedAt !== undefined,
        "startedAt should be defined"
      )
      assert.ok(
        taskStats.finishedAt !== undefined,
        "finishedAt should be defined"
      )
      assert.ok(
        taskStats.durationMs !== undefined,
        "durationMs should be defined"
      )

      // TypeScript type narrowing
      if (
        taskStats.startedAt !== undefined &&
        taskStats.finishedAt !== undefined
      ) {
        assert.ok(taskStats.finishedAt >= taskStats.startedAt)
      }
    })
  })

  describe("skipped tasks", () => {
    it("includes command but no execution fields for skipped task", async () => {
      const task1 = task({
        name: "task1",
        commands: {
          dev: "echo task1",
          // No build command
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)

      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "skipped")
      assert.strictEqual(taskStats.command, "build")
      assert.strictEqual(typeof taskStats.finishedAt, "number")
      assert.strictEqual(taskStats.durationMs, 0)

      // Skipped tasks don't have execution fields
      assert.strictEqual(taskStats.startedAt, undefined)
      assert.strictEqual(taskStats.exitCode, undefined)
      assert.strictEqual(taskStats.signal, undefined)
      assert.strictEqual(taskStats.error, undefined)
      assert.strictEqual(taskStats.teardown, undefined)
    })
  })

  describe("mixed scenarios", () => {
    it("correctly populates stats for mix of completed, skipped, and failed tasks", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })
      const task2 = task({
        name: "task2",
        commands: {
          dev: "echo task2",
          // No build command - will be skipped
        },
        dependencies: [task1],
      })
      const task3 = task({
        name: "task3",
        commands: { dev: "echo task3", build: "echo task3" },
        dependencies: [task2],
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "task3",
            handler: { exitCode: 1 }, // task3 fails
          },
        ],
      })

      const pipe = pipeline([task1, task2, task3])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.stats.status, "failed")
      assert.strictEqual(result.stats.summary.total, 3)
      assert.strictEqual(result.stats.summary.completed, 1) // task1
      assert.strictEqual(result.stats.summary.skipped, 1) // task2
      assert.strictEqual(result.stats.summary.failed, 1) // task3

      // Verify task1 (completed)
      const task1Stats = result.stats.tasks.find((t) => t.name === "task1")!
      assert.strictEqual(task1Stats.status, "completed")
      assert.strictEqual(task1Stats.exitCode, 0)

      // Verify task2 (skipped)
      const task2Stats = result.stats.tasks.find((t) => t.name === "task2")!
      assert.strictEqual(task2Stats.status, "skipped")
      assert.strictEqual(task2Stats.command, "build")

      // Verify task3 (failed)
      const task3Stats = result.stats.tasks.find((t) => t.name === "task3")!
      assert.strictEqual(task3Stats.status, "failed")
      assert.strictEqual(task3Stats.exitCode, 1)
      assert.ok(task3Stats.error instanceof Error)
    })

    it("includes dependencies and dependents for all tasks", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "echo task2", build: "echo task2" },
        dependencies: [task1],
      })
      const task3 = task({
        name: "task3",
        commands: { dev: "echo task3", build: "echo task3" },
        dependencies: [task1],
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1, task2, task3])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const task1Stats = result.stats.tasks.find((t) => t.name === "task1")!
      const task2Stats = result.stats.tasks.find((t) => t.name === "task2")!
      const task3Stats = result.stats.tasks.find((t) => t.name === "task3")!

      // task1 has no dependencies, but has dependents
      assert.strictEqual(task1Stats.dependencies.length, 0)
      assert.strictEqual(task1Stats.dependents.length, 2)
      assert.ok(task1Stats.dependents.includes(task2Stats.id))
      assert.ok(task1Stats.dependents.includes(task3Stats.id))

      // task2 and task3 depend on task1
      assert.strictEqual(task2Stats.dependencies.length, 1)
      assert.ok(task2Stats.dependencies.includes(task1Stats.id))
      assert.strictEqual(task2Stats.dependents.length, 0)

      assert.strictEqual(task3Stats.dependencies.length, 1)
      assert.ok(task3Stats.dependencies.includes(task1Stats.id))
      assert.strictEqual(task3Stats.dependents.length, 0)
    })
  })

  describe("teardown scenarios", () => {
    it("includes teardown status when teardown fails", async () => {
      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "exit 1", // Teardown will fail
          },
          build: "echo task1",
        },
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "exit 1",
            handler: { exitCode: 1 }, // Teardown fails
          },
        ],
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      // Pipeline still succeeds even if teardown fails
      assert.strictEqual(result.ok, true)

      const taskStats = result.stats.tasks[0]
      assert.ok(taskStats.teardown !== undefined)
      assert.strictEqual(taskStats.teardown!.status, "failed")
      assert.ok(taskStats.teardown!.error instanceof Error)
    })

    it("does not include teardown for tasks without teardown command", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.teardown, undefined)
    })
  })

  describe("pending tasks", () => {
    it("includes pending status for tasks that never started", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "echo task2", build: "echo task2" },
        dependencies: [task1],
      })

      // task1 fails immediately, so task2 never starts
      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "task1",
            handler: { exitCode: 1 },
          },
        ],
      })

      const pipe = pipeline([task1, task2])
      const result = await pipe.run({ spawn: mockSpawn as any })

      assert.strictEqual(result.ok, false)

      const task2Stats = result.stats.tasks.find((t) => t.name === "task2")!
      assert.strictEqual(task2Stats.status, "pending")
      assert.strictEqual(task2Stats.command, undefined)
      assert.strictEqual(task2Stats.startedAt, undefined)
      assert.strictEqual(task2Stats.finishedAt, undefined)
      assert.strictEqual(task2Stats.durationMs, undefined)
      assert.strictEqual(task2Stats.exitCode, undefined)
      assert.strictEqual(task2Stats.error, undefined)
    })
  })
})
