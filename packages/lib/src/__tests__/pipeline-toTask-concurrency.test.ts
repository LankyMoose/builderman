import assert from "node:assert"
import { describe, it } from "node:test"

import { pipeline } from "../pipeline.js"
import { task } from "../task.js"
import { $TASK_INTERNAL } from "../internal/constants.js"
import { createMockSpawn } from "./helpers.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tracks peak concurrent inner-task count across begin/complete callbacks. */
function makeConcurrencyTracker(filter: (name: string) => boolean) {
  let current = 0
  let peak = 0
  const starts: string[] = []

  return {
    onTaskBegin(name: string) {
      if (!filter(name)) return
      current++
      peak = Math.max(peak, current)
      starts.push(name)
    },
    onTaskComplete(name: string) {
      if (!filter(name)) return
      current--
    },
    get peak() {
      return peak
    },
    get starts() {
      return starts
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pipeline.toTask() — maxConcurrency", () => {
  // -------------------------------------------------------------------------
  // API shape
  // -------------------------------------------------------------------------

  describe("internal storage", () => {
    it("stores a numeric maxConcurrency on the synthetic task", () => {
      const t = task({ name: "t", commands: { build: "echo t" } })
      const pt = pipeline([t]).toTask({ name: "pt", maxConcurrency: 1 })
      assert.strictEqual(pt[$TASK_INTERNAL].maxConcurrency, 1)
    })

    it("stores a function maxConcurrency on the synthetic task", () => {
      const fn = (cmd: string) => (cmd === "test" ? 1 : Infinity)
      const t = task({ name: "t", commands: { build: "echo t" } })
      const pt = pipeline([t]).toTask({ name: "pt", maxConcurrency: fn })
      assert.strictEqual(pt[$TASK_INTERNAL].maxConcurrency, fn)
    })

    it("leaves maxConcurrency undefined when not provided", () => {
      const t = task({ name: "t", commands: { build: "echo t" } })
      const pt = pipeline([t]).toTask({ name: "pt" })
      assert.strictEqual(pt[$TASK_INTERNAL].maxConcurrency, undefined)
    })

    it("stores Infinity explicitly", () => {
      const t = task({ name: "t", commands: { build: "echo t" } })
      const pt = pipeline([t]).toTask({ name: "pt", maxConcurrency: Infinity })
      assert.strictEqual(pt[$TASK_INTERNAL].maxConcurrency, Infinity)
    })
  })

  // -------------------------------------------------------------------------
  // Concurrency — numeric limit
  // -------------------------------------------------------------------------

  describe("numeric limit", () => {
    it("enforces maxConcurrency: 1 (sequential execution inside the pipeline task)", async () => {
      const tasks = Array.from({ length: 4 }, (_, i) =>
        task({
          name: `seq-task${i + 1}`,
          commands: { test: `echo seq-task${i + 1}` },
        })
      )

      const pt = pipeline(tasks).toTask({ name: "seq-pt", maxConcurrency: 1 })

      const tracker = makeConcurrencyTracker((name) =>
        name.includes("seq-task")
      )

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `seq-task${i + 1}`,
          handler: { exitDelay: 30 },
        })),
      })

      const result = await pipeline([pt]).run({
        command: "test",
        spawn: mockSpawn as any,
        onTaskBegin: (name) => tracker.onTaskBegin(name),
        onTaskComplete: (name) => tracker.onTaskComplete(name),
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(
        tracker.peak,
        1,
        `maxConcurrency:1 should run at most 1 inner task at a time; peak was ${tracker.peak}`
      )
      assert.strictEqual(tracker.starts.length, 4)
    })

    it("allows up to N inner tasks to run concurrently with maxConcurrency: 2", async () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        task({
          name: `par-task${i + 1}`,
          commands: { build: `echo par-task${i + 1}` },
        })
      )

      const pt = pipeline(tasks).toTask({ name: "par-pt", maxConcurrency: 2 })

      const tracker = makeConcurrencyTracker((name) =>
        name.includes("par-task")
      )

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `par-task${i + 1}`,
          handler: { exitDelay: 40 },
        })),
      })

      const result = await pipeline([pt]).run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskBegin: (name) => tracker.onTaskBegin(name),
        onTaskComplete: (name) => tracker.onTaskComplete(name),
      })

      assert.strictEqual(result.ok, true)
      assert.ok(
        tracker.peak <= 2,
        `Expected at most 2 concurrent inner tasks; peak was ${tracker.peak}`
      )
      assert.strictEqual(tracker.starts.length, 5)
    })

    it("defaults to Infinity — all independent tasks start together when not set", async () => {
      const tasks = Array.from({ length: 4 }, (_, i) =>
        task({
          name: `inf-task${i + 1}`,
          commands: { build: `echo inf-task${i + 1}` },
        })
      )

      const pt = pipeline(tasks).toTask({ name: "inf-pt" }) // no maxConcurrency

      const tracker = makeConcurrencyTracker((name) =>
        name.includes("inf-task")
      )

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `inf-task${i + 1}`,
          handler: { exitDelay: 40 },
        })),
      })

      const result = await pipeline([pt]).run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskBegin: (name) => tracker.onTaskBegin(name),
        onTaskComplete: (name) => tracker.onTaskComplete(name),
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(
        tracker.peak,
        4,
        `With no maxConcurrency all 4 tasks should start together; peak was ${tracker.peak}`
      )
    })
  })

  // -------------------------------------------------------------------------
  // Concurrency — function form
  // -------------------------------------------------------------------------

  describe("function form", () => {
    it("receives the command name and applies the returned limit", async () => {
      const tasks = Array.from({ length: 3 }, (_, i) =>
        task({
          name: `fn-task${i + 1}`,
          commands: {
            build: `echo fn-task${i + 1}`,
            test: `echo fn-task${i + 1}`,
          },
        })
      )

      // Sequential for "test", unlimited for everything else
      const pt = pipeline(tasks).toTask({
        name: "fn-pt",
        maxConcurrency: (cmd) => (cmd === "test" ? 1 : Infinity),
      })

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `fn-task${i + 1}`,
          handler: { exitDelay: 30 },
        })),
      })

      // --- "test" → sequential ---
      {
        const tracker = makeConcurrencyTracker((name) =>
          name.includes("fn-task")
        )
        const result = await pipeline([pt]).run({
          command: "test",
          spawn: mockSpawn as any,
          onTaskBegin: (name) => tracker.onTaskBegin(name),
          onTaskComplete: (name) => tracker.onTaskComplete(name),
        })
        assert.strictEqual(result.ok, true)
        assert.strictEqual(
          tracker.peak,
          1,
          `function should return 1 for "test"; peak was ${tracker.peak}`
        )
      }

      // --- "build" → unlimited ---
      {
        const tracker = makeConcurrencyTracker((name) =>
          name.includes("fn-task")
        )
        const result = await pipeline([pt]).run({
          command: "build",
          spawn: mockSpawn as any,
          onTaskBegin: (name) => tracker.onTaskBegin(name),
          onTaskComplete: (name) => tracker.onTaskComplete(name),
        })
        assert.strictEqual(result.ok, true)
        assert.strictEqual(
          tracker.peak,
          3,
          `function should return Infinity for "build"; peak was ${tracker.peak}`
        )
      }
    })
  })

  // -------------------------------------------------------------------------
  // Isolation from outer pipeline's maxConcurrency
  // -------------------------------------------------------------------------

  describe("isolation from outer maxConcurrency", () => {
    it("inner maxConcurrency overrides the outer pipeline's maxConcurrency", async () => {
      const outerTask = task({
        name: "outer",
        commands: { build: "echo outer" },
      })

      const innerTasks = Array.from({ length: 3 }, (_, i) =>
        task({
          name: `inner-task${i + 1}`,
          commands: { build: `echo inner-task${i + 1}` },
        })
      )

      const pt = pipeline(innerTasks).toTask({
        name: "inner-pt",
        maxConcurrency: 1,
      })

      const tracker = makeConcurrencyTracker((name) =>
        name.includes("inner-task")
      )

      const mockSpawn = createMockSpawn({
        commands: innerTasks.map((_, i) => ({
          match: `inner-task${i + 1}`,
          handler: { exitDelay: 30 },
        })),
      })

      // Outer pipeline has maxConcurrency: 10 — inner should still be capped at 1
      const result = await pipeline([outerTask, pt]).run({
        command: "build",
        spawn: mockSpawn as any,
        maxConcurrency: 10,
        onTaskBegin: (name) => tracker.onTaskBegin(name),
        onTaskComplete: (name) => tracker.onTaskComplete(name),
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(
        tracker.peak,
        1,
        `inner maxConcurrency:1 should not be overridden by outer maxConcurrency:10; peak was ${tracker.peak}`
      )
    })
  })

  // -------------------------------------------------------------------------
  // Outer dependencies are not re-run inside the pipeline task
  // -------------------------------------------------------------------------

  describe("shared outer dependencies", () => {
    it("does not re-run tasks that inner tasks depend on via command deps", async () => {
      const shared = task({
        name: "shared",
        commands: { build: "echo shared" },
      })
      const t1 = task({
        name: "consumer1",
        commands: { build: { run: "echo consumer1", dependencies: [shared] } },
      })
      const t2 = task({
        name: "consumer2",
        commands: { build: { run: "echo consumer2", dependencies: [shared] } },
      })

      const pt = pipeline([t1, t2]).toTask({ name: "consumers-pt" })

      const spawnCalls: string[] = []
      const mockSpawn = createMockSpawn()
      const wrappedSpawn = (cmd: string, args: string[], opts?: unknown) => {
        spawnCalls.push([cmd, ...(args ?? [])].join(" "))
        return (mockSpawn as any)(cmd, args, opts)
      }

      const result = await pipeline([shared, pt]).run({
        command: "build",
        spawn: wrappedSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      const sharedSpawns = spawnCalls.filter((c) => c.includes("echo shared"))
      assert.strictEqual(
        sharedSpawns.length,
        1,
        `"shared" should only be spawned once; found: ${sharedSpawns.join(", ")}`
      )
    })

    it("does not re-run tasks that inner tasks depend on via task-level deps", async () => {
      const shared = task({
        name: "shared-tl",
        commands: { build: "echo shared-tl" },
      })
      const inner = task({
        name: "inner-tl",
        commands: { build: "echo inner-tl" },
        dependencies: [shared],
      })

      const pt = pipeline([inner]).toTask({ name: "tl-pt" })

      const spawnCalls: string[] = []
      const mockSpawn = createMockSpawn()
      const wrappedSpawn = (cmd: string, args: string[], opts?: unknown) => {
        spawnCalls.push([cmd, ...(args ?? [])].join(" "))
        return (mockSpawn as any)(cmd, args, opts)
      }

      const result = await pipeline([shared, pt]).run({
        command: "build",
        spawn: wrappedSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      const sharedSpawns = spawnCalls.filter((c) =>
        c.includes("echo shared-tl")
      )
      assert.strictEqual(
        sharedSpawns.length,
        1,
        `task-level dep should only be spawned once; found: ${sharedSpawns.join(", ")}`
      )
    })
  })

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  describe("composition", () => {
    it("pipeline task can be used as a dependency of another task", async () => {
      const t1 = task({ name: "dep-t1", commands: { build: "echo dep-t1" } })
      const t2 = task({ name: "dep-t2", commands: { build: "echo dep-t2" } })
      const pt = pipeline([t1, t2]).toTask({ name: "dep-pt" })

      const downstream = task({
        name: "downstream",
        commands: { build: { run: "echo downstream", dependencies: [pt] } },
      })

      const mockSpawn = createMockSpawn()
      const executionOrder: string[] = []

      const result = await pipeline([pt, downstream]).run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskBegin: (name) => executionOrder.push(name),
      })

      assert.strictEqual(result.ok, true)
      const ptIdx = executionOrder.indexOf("dep-pt")
      const downstreamIdx = executionOrder.indexOf("downstream")
      assert.ok(ptIdx !== -1, "pipeline task should appear in execution")
      assert.ok(downstreamIdx !== -1, "downstream should appear in execution")
      assert.ok(ptIdx < downstreamIdx, "pipeline task should start before downstream")
    })
  })
})
