import assert from "node:assert"
import { describe, it, mock } from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { pipeline } from "./pipeline.js"
import { PipelineError } from "./pipeline-error.js"
import { task } from "./task.js"

// Test helpers
interface CommandHandler {
  exitCode?: number | null
  exitDelay?: number
  onSpawn?: (process: ChildProcess) => void
}

function createMockSpawn(options?: {
  // Default behavior for all commands
  exitCode?: number | null
  // Command-specific handlers (checked in order)
  commands?: Array<{
    match: string | RegExp | ((command: string) => boolean)
    handler: CommandHandler
  }>
  // Fallback handler for unmatched commands
  commandHandler?: (command: string, process: ChildProcess) => void
}): ReturnType<typeof mock.fn> {
  return mock.fn((command: string) => {
    const mockProcess = new EventEmitter() as ChildProcess
    mockProcess.kill = mock.fn() as any
    mockProcess.stdout = new EventEmitter() as any
    mockProcess.stderr = new EventEmitter() as any

    // Find matching command handler
    let matchedHandler: CommandHandler | undefined
    if (options?.commands) {
      for (const cmd of options.commands) {
        let matches = false
        if (typeof cmd.match === "string") {
          matches = command.includes(cmd.match)
        } else if (cmd.match instanceof RegExp) {
          matches = cmd.match.test(command)
        } else {
          matches = cmd.match(command)
        }
        if (matches) {
          matchedHandler = cmd.handler
          break
        }
      }
    }

    // Apply handler
    const handler = matchedHandler || {}
    const exitCode = handler.exitCode ?? options?.exitCode ?? 0
    const exitDelay = handler.exitDelay ?? 0

    // Handler onSpawn
    handler.onSpawn?.(mockProcess)

    // Fallback commandHandler
    if (!matchedHandler && options?.commandHandler) {
      options.commandHandler(command, mockProcess)
      // When commandHandler is used, it handles exit, so don't auto-exit
      return mockProcess
    }

    // Auto-exit unless disabled
    if (exitDelay > 0) {
      setTimeout(() => {
        mockProcess.emit("exit", exitCode)
      }, exitDelay)
    } else {
      setImmediate(() => {
        mockProcess.emit("exit", exitCode)
      })
    }

    return mockProcess
  }) as any
}

describe("createTaskGraph", () => {
  it("creates nodes for all tasks", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
    })

    const graph = createTaskGraph([task1, task2])

    assert.strictEqual(graph.nodes.size, 2)
    assert.ok(graph.nodes.has(task1[$TASK_INTERNAL].id))
    assert.ok(graph.nodes.has(task2[$TASK_INTERNAL].id))
  })

  it("builds dependency relationships", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })

    const graph = createTaskGraph([task1, task2])
    const node1 = graph.nodes.get(task1[$TASK_INTERNAL].id)!
    const node2 = graph.nodes.get(task2[$TASK_INTERNAL].id)!

    assert.strictEqual(node1.dependencies.size, 0)
    assert.strictEqual(node1.dependents.size, 1)
    assert.ok(node1.dependents.has(task2[$TASK_INTERNAL].id))

    assert.strictEqual(node2.dependencies.size, 1)
    assert.ok(node2.dependencies.has(task1[$TASK_INTERNAL].id))
    assert.strictEqual(node2.dependents.size, 0)
  })

  it("throws error if dependency is not in pipeline", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })

    // task2 depends on task1, but task1 is not in the pipeline
    assert.throws(
      () => createTaskGraph([task2]),
      /Task "task2" depends on "task1" which is not in the pipeline/
    )
  })
})

describe("TaskGraph.validate", () => {
  it("validates graph without cycles", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })

    const graph = createTaskGraph([task1, task2])
    assert.doesNotThrow(() => graph.validate())
  })

  it("detects simple circular dependency", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })
    // Create circular dependency
    task1[$TASK_INTERNAL].dependencies.push(task2)

    const graph = createTaskGraph([task1, task2])
    assert.throws(() => graph.validate(), /Circular dependency detected/)
  })

  it("detects longer circular dependency chain", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })
    const task3 = task({
      name: "task3",
      commands: { dev: "echo 3", build: "echo 3" },
      cwd: ".",
      dependencies: [task2],
    })
    // Create cycle: task1 -> task2 -> task3 -> task1
    // We need to add task3 to task1's dependencies to complete the cycle
    // Note: We modify dependencies BEFORE creating the graph because
    // createTaskGraph reads dependencies at creation time
    task1[$TASK_INTERNAL].dependencies.push(task3)

    const graph = createTaskGraph([task1, task2, task3])
    // Validate BEFORE simplify, because simplify might remove edges that are part of cycles
    assert.throws(() => graph.validate(), /Circular dependency detected/)
  })
})

describe("TaskGraph.simplify", () => {
  it("removes transitive dependencies", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })
    // task3 depends on both task1 and task2, but task2 already depends on task1
    // So task3 -> task1 is transitive
    const task3 = task({
      name: "task3",
      commands: { dev: "echo 3", build: "echo 3" },
      cwd: ".",
      dependencies: [task1, task2],
    })

    const graph = createTaskGraph([task1, task2, task3])
    graph.simplify()

    const node3 = graph.nodes.get(task3[$TASK_INTERNAL].id)!
    // After simplification, task3 should only depend on task2 (task1 is transitive)
    assert.strictEqual(node3.dependencies.size, 1)
    assert.ok(node3.dependencies.has(task2[$TASK_INTERNAL].id))
    assert.ok(!node3.dependencies.has(task1[$TASK_INTERNAL].id))
  })

  it("keeps non-transitive dependencies", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
    })
    // task3 depends on both task1 and task2, but they're independent
    const task3 = task({
      name: "task3",
      commands: { dev: "echo 3", build: "echo 3" },
      cwd: ".",
      dependencies: [task1, task2],
    })

    const graph = createTaskGraph([task1, task2, task3])
    graph.simplify()

    const node3 = graph.nodes.get(task3[$TASK_INTERNAL].id)!
    // Both dependencies should remain
    assert.strictEqual(node3.dependencies.size, 2)
    assert.ok(node3.dependencies.has(task1[$TASK_INTERNAL].id))
    assert.ok(node3.dependencies.has(task2[$TASK_INTERNAL].id))
  })
})

describe("pipeline", () => {
  it("validates graph on creation", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
      cwd: ".",
      dependencies: [task1],
    })
    // Create circular dependency
    task1[$TASK_INTERNAL].dependencies.push(task2)

    assert.throws(
      () => pipeline([task1, task2]),
      /Circular dependency detected/
    )
  })

  it("runs tasks in dependency order", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      dependencies: [task1],
    })

    const mockSpawn = createMockSpawn()

    const pipe = pipeline([task1, task2])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        executionOrder.push(name)
      },
      onTaskComplete: (name) => {
        executionOrder.push(`complete:${name}`)
      },
    })

    // Check result
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.error, null)
    assert.strictEqual(result.stats.status, "success")
    assert.strictEqual(result.stats.summary.total, 2)
    assert.strictEqual(result.stats.summary.completed, 2)
    assert.strictEqual(result.stats.summary.failed, 0)
    assert.strictEqual(result.stats.summary.skipped, 0)

    // task1 should start before task2
    assert.strictEqual(executionOrder.indexOf("task1"), 0)
    assert.ok(executionOrder.indexOf("task2") > executionOrder.indexOf("task1"))
  })

  it("handles task failures", async () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
    })

    const mockSpawn = createMockSpawn({ exitCode: 1 })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
    })

    // Check result
    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.TaskFailed)
    assert.strictEqual(
      result.error.message,
      "[task1] Task failed with non-zero exit code: 1"
    )
    assert.strictEqual(result.stats.status, "failed")
    assert.strictEqual(result.stats.summary.total, 1)
    assert.strictEqual(result.stats.summary.completed, 0)
    assert.strictEqual(result.stats.summary.failed, 1)

    // Check task stats
    const taskStats = Object.values(result.stats.tasks)[0]
    assert.strictEqual(taskStats.status, "failed")
    assert.strictEqual(taskStats.exitCode, 1)
    assert.ok(taskStats.error)
    assert.ok(taskStats.startedAt)
    assert.ok(taskStats.finishedAt)
    assert.ok(taskStats.durationMs !== undefined)
  })

  it("returns success result when all tasks complete", async () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
    })

    const mockSpawn = createMockSpawn()

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
    })

    // Check result
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.error, null)
    assert.strictEqual(result.stats.status, "success")
    assert.strictEqual(result.stats.summary.total, 1)
    assert.strictEqual(result.stats.summary.completed, 1)
    assert.strictEqual(result.stats.summary.failed, 0)

    // Check task stats
    const taskStats = Object.values(result.stats.tasks)[0]
    assert.strictEqual(taskStats.status, "completed")
    assert.strictEqual(taskStats.exitCode, 0)
    assert.ok(taskStats.startedAt)
    assert.ok(taskStats.finishedAt)
    assert.ok(taskStats.durationMs !== undefined)
  })

  it("waits for task with isReady before starting dependent task", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo task1",
          readyWhen: (output) => output.includes("READY"),
        },
        build: "echo task1",
      },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      dependencies: [task1],
    })

    const mockSpawn = createMockSpawn({
      commandHandler: (command, process) => {
        if (command.includes("task1")) {
          // Emit stdout that doesn't match ready condition
          setImmediate(() => {
            process.stdout?.emit("data", Buffer.from("Starting...\n"))
          })
          // Then emit ready condition after a delay
          setTimeout(() => {
            executionOrder.push("task1:before-ready")
            process.stdout?.emit("data", Buffer.from("READY\n"))
            executionOrder.push("task1:after-ready")
          }, 10)
          // Complete after ready
          setTimeout(() => {
            process.emit("exit", 0)
          }, 20)
        } else if (command.includes("task2")) {
          setImmediate(() => {
            process.emit("exit", 0)
          })
        }
      },
    })

    const pipe = pipeline([task1, task2])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        executionOrder.push(`${name}:started`)
      },
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.stats.status, "success")

    // task1 should start first
    assert.strictEqual(executionOrder.indexOf("task1:started"), 0)
    // task1 should become ready before task2 starts
    // The ready event is processed synchronously when stdout emits
    // task1:before-ready is pushed before emitting, task2:started happens during emission processing,
    // and task1:after-ready is pushed after emitting
    // So the order should be: task1:before-ready, task2:started, task1:after-ready
    const task1BeforeReadyIndex = executionOrder.indexOf("task1:before-ready")
    const task2StartedIndex = executionOrder.indexOf("task2:started")
    const task1AfterReadyIndex = executionOrder.indexOf("task1:after-ready")
    assert.ok(
      task1BeforeReadyIndex < task2StartedIndex,
      "task2 should start after task1 ready event is triggered"
    )
    assert.ok(
      task2StartedIndex < task1AfterReadyIndex,
      "task2 starts during ready event processing"
    )
  })

  it("starts dependent task immediately when task has no isReady", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      dependencies: [task1],
    })

    const mockSpawn = createMockSpawn({
      commands: [
        {
          match: "task1",
          handler: { exitDelay: 50 },
        },
        {
          match: "task2",
          handler: {},
        },
      ],
    })

    const pipe = pipeline([task1, task2])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        executionOrder.push(`${name}:started`)
      },
    })

    assert.strictEqual(result.ok, true)

    // task1 should start first
    assert.strictEqual(executionOrder.indexOf("task1:started"), 0)
    // task2 should start immediately after task1 (no waiting for ready or completion)
    // Since task1 has no isReady, it's marked as ready immediately when it starts,
    // so task2 should start right away
    const task2StartedIndex = executionOrder.indexOf("task2:started")
    // task2 should start very soon after task1 (they should be close in execution order)
    assert.ok(task2StartedIndex === 1, "task2 should start after task1")
  })

  it("starts multiple dependents when task with isReady becomes ready", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo task1",
          readyWhen: (output) => output.includes("READY"),
        },
        build: "echo task1",
      },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      dependencies: [task1],
    })
    const task3 = task({
      name: "task3",
      commands: { dev: "echo task3", build: "echo task3" },
      cwd: ".",
      dependencies: [task1],
    })

    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      if (command.includes("task1")) {
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 20)
      } else if (command.includes("task2")) {
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      } else if (command.includes("task3")) {
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2, task3])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        executionOrder.push(`${name}:started`)
      },
    })

    assert.strictEqual(result.ok, true)

    // task1 should start first
    assert.strictEqual(executionOrder.indexOf("task1:started"), 0)
    // task1 should become ready
    const task1BeforeReadyIndex = executionOrder.indexOf("task1:before-ready")
    assert.ok(task1BeforeReadyIndex > 0, "task1 should become ready")
    // Both task2 and task3 should start after task1 ready event is triggered
    const task2StartedIndex = executionOrder.indexOf("task2:started")
    const task3StartedIndex = executionOrder.indexOf("task3:started")
    assert.ok(
      task2StartedIndex > task1BeforeReadyIndex,
      "task2 should start after task1 ready event is triggered"
    )
    assert.ok(
      task3StartedIndex > task1BeforeReadyIndex,
      "task3 should start after task1 ready event is triggered"
    )
  })

  it("waits for all dependencies with isReady before starting dependent task", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo task1",
          readyWhen: (output) => output.includes("TASK1_READY"),
        },
        build: "echo task1",
      },
      cwd: ".",
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: {
          run: "echo task2",
          readyWhen: (output) => output.includes("TASK2_READY"),
        },
        build: "echo task2",
      },
      cwd: ".",
    })
    const task3 = task({
      name: "task3",
      commands: { dev: "echo task3", build: "echo task3" },
      cwd: ".",
      dependencies: [task1, task2],
    })

    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      if (command.includes("task1")) {
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK1_READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 30)
      } else if (command.includes("task2")) {
        setTimeout(() => {
          executionOrder.push("task2:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK2_READY\n"))
          executionOrder.push("task2:after-ready")
        }, 20)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 40)
      } else if (command.includes("task3")) {
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2, task3])
    const result = await pipe.run({
      spawn: mockSpawn as any,
      onTaskBegin: (name) => {
        executionOrder.push(`${name}:started`)
      },
    })

    assert.strictEqual(result.ok, true)

    // task1 and task2 should start (order doesn't matter)
    assert.ok(executionOrder.includes("task1:started"))
    assert.ok(executionOrder.includes("task2:started"))
    // Both should become ready
    assert.ok(executionOrder.includes("task1:before-ready"))
    assert.ok(executionOrder.includes("task2:before-ready"))
    // task3 should start only after both ready events are triggered
    const task1BeforeReadyIndex = executionOrder.indexOf("task1:before-ready")
    const task2BeforeReadyIndex = executionOrder.indexOf("task2:before-ready")
    const task3StartedIndex = executionOrder.indexOf("task3:started")
    const lastReadyIndex = Math.max(
      task1BeforeReadyIndex,
      task2BeforeReadyIndex
    )
    assert.ok(
      task3StartedIndex > lastReadyIndex,
      "task3 should start after both dependencies' ready events are triggered"
    )
  })

  it("cancels pipeline when abort signal is triggered", async () => {
    const abortController = new AbortController()
    let taskKilled = false

    const task1 = task({
      name: "task1",
      commands: { dev: "sleep 1", build: "sleep 1" },
      cwd: ".",
    })

    const task2 = task({
      name: "task2",
      commands: { dev: "sleep 1", build: "sleep 1" },
      cwd: ".",
      dependencies: [task1], // task2 depends on task1, so it starts after task1 completes
    })

    let spawnCallCount = 0
    let task2Started = false

    const mockSpawn = mock.fn((_command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      const isTask1 = spawnCallCount === 0
      spawnCallCount++

      if (!isTask1) {
        task2Started = true
      }

      mockProcess.kill = mock.fn((signal?: string | number) => {
        if (!isTask1) {
          taskKilled = true
        }
        // Simulate process termination after kill
        setImmediate(() => {
          mockProcess.emit("exit", signal === "SIGTERM" ? null : 1)
        })
      }) as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // task1 completes immediately, task2 waits to be killed
      if (isTask1) {
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }
      // task2 doesn't auto-complete - it will be killed when signal is aborted

      return mockProcess
    })

    const pipe = pipeline([task1, task2])
    const completedTasks: string[] = []

    const result = await pipe.run({
      spawn: mockSpawn as any,
      signal: abortController.signal,
      onTaskComplete: (name) => {
        completedTasks.push(name)
        if (name === "task1") {
          // Wait a bit to ensure task2 starts, then abort
          setTimeout(() => {
            abortController.abort()
          }, 5)
        }
      },
    })

    // Check result
    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.Aborted)
    assert.strictEqual(result.stats.status, "aborted")

    // Wait a bit for all async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.ok(completedTasks.length === 1, "Only one task should be completed")
    assert.ok(task2Started, "Task2 should have started")
    // Verify that the task was killed
    assert.ok(taskKilled, "Task should be killed when signal is aborted")
    // Verify the error in the result
    assert.ok(
      result.error.code === PipelineError.Aborted,
      "Error message should indicate pipeline was aborted"
    )
  })

  it("throws error immediately if signal is already aborted", async () => {
    const abortController = new AbortController()
    abortController.abort()

    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
      cwd: ".",
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      signal: abortController.signal,
    })

    // Check result
    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(
      result.error.code,
      PipelineError.Aborted,
      `Error should indicate signal was already aborted. Got ${result.error.code}. Message: ${result.error}`
    )
    assert.strictEqual(result.stats.status, "aborted")
  })

  describe("teardown", () => {
    it("executes teardown on successful completion", async () => {
      let teardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          build: "echo task1",
        },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "teardown",
            handler: {
              onSpawn: () => {
                teardownExecuted = true
              },
            },
          },
        ],
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.status, "success")

      // Check teardown status
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.teardown?.status, "completed")

      assert.ok(
        teardownExecuted,
        "Teardown should be executed on successful completion"
      )
    })

    it("executes teardown on task failure after starting", async () => {
      let teardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          build: "echo task1",
        },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "task1",
            handler: {
              exitDelay: 50,
              exitCode: 1,
            },
          },
          {
            match: "teardown",
            handler: {
              onSpawn: () => {
                teardownExecuted = true
              },
            },
          },
        ],
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.stats.status, "failed")

      // Check teardown status
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.teardown?.status, "completed")

      assert.ok(
        teardownExecuted,
        "Teardown should be executed on task failure after starting"
      )
    })

    it("executes teardown when pipeline is cancelled", async () => {
      const abortController = new AbortController()
      let teardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "sleep 1",
            teardown: "echo teardown",
          },
          build: "sleep 1",
        },
        cwd: ".",
      })

      const mockSpawn = mock.fn((command: string) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        if (command.includes("teardown")) {
          teardownExecuted = true
          setImmediate(() => {
            mockProcess.emit("exit", 0)
          })
        } else {
          // Main command - don't auto-complete, will be killed
        }

        return mockProcess
      })

      const pipe = pipeline([task1])
      const runPromise = pipe.run({
        spawn: mockSpawn as any,
        signal: abortController.signal,
      })

      // Wait a bit to ensure task starts
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Abort the signal
      abortController.abort()

      const result = await runPromise

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.stats.status, "aborted")

      // Check teardown status
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.teardown?.status, "completed")

      assert.ok(
        teardownExecuted,
        "Teardown should be executed when pipeline is cancelled"
      )
    })

    it("does not execute teardown if task was skipped (no command for mode)", async () => {
      let teardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          // No build command - task will be skipped in production mode
        },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "teardown",
            handler: {
              onSpawn: () => {
                teardownExecuted = true
              },
            },
          },
        ],
      })

      // Run in production mode (build command)
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = "production"

      const pipe = pipeline([task1])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })
      process.env.NODE_ENV = originalEnv

      assert.strictEqual(result.ok, true)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "skipped")
      // Teardown is undefined for skipped tasks (never registered)
      assert.strictEqual(taskStats.teardown, undefined)

      assert.ok(
        !teardownExecuted,
        "Teardown should NOT be executed if task was skipped (no command for this mode)"
      )
    })

    it("does not execute teardown if task failed before starting command", async () => {
      let teardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          build: "echo task1",
        },
        cwd: "./nonexistent-directory", // Invalid cwd - will fail before spawning
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "teardown",
            handler: {
              onSpawn: () => {
                teardownExecuted = true
              },
            },
          },
        ],
      })

      const pipe = pipeline([task1])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, false)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "failed")
      // Teardown is undefined for tasks that failed before starting (never registered)
      assert.strictEqual(taskStats.teardown, undefined)

      assert.ok(
        !teardownExecuted,
        "Teardown should NOT be executed if task failed before starting command"
      )
    })

    it("does not execute teardown if pipeline never began execution", async () => {
      let task2Spawned = false
      let task2TeardownExecuted = false

      const task1 = task({
        name: "task1",
        commands: {
          dev: {
            run: "echo task1",
            teardown: "echo teardown",
          },
          build: "echo task1",
        },
        cwd: ".",
      })

      const task2 = task({
        name: "task2",
        commands: {
          dev: {
            run: "echo task2",
            teardown: "echo teardown2",
          },
          build: "echo task2",
        },
        cwd: ".",
        dependencies: [task1],
      })

      const mockSpawn = mock.fn((command: string) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        if (command.includes("task2")) {
          task2Spawned = true
        }

        if (command.includes("teardown2")) {
          task2TeardownExecuted = true
          setImmediate(() => {
            mockProcess.emit("exit", 0)
          })
        } else if (command.includes("task1")) {
          // task1 fails immediately
          setImmediate(() => {
            mockProcess.emit("exit", 1)
          })
        } else if (
          command.includes("teardown") &&
          !command.includes("teardown2")
        ) {
          // task1's teardown
          setImmediate(() => {
            mockProcess.emit("exit", 0)
          })
        }

        return mockProcess
      })

      const pipe = pipeline([task1, task2])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.stats.status, "failed")

      // Wait a bit for any async operations
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.ok(
        !task2Spawned,
        "task2 should not be spawned if pipeline fails before it can start"
      )
      assert.ok(
        !task2TeardownExecuted,
        "task2's teardown should NOT be executed if task2 never started"
      )

      // Check task2 stats
      const task2Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task2"
      )
      assert.ok(task2Stats)
      assert.strictEqual(task2Stats.status, "pending")
    })

    it("executes teardowns in reverse dependency order", async () => {
      const teardownOrder: string[] = []

      const db = task({
        name: "db",
        commands: {
          dev: {
            run: "echo db",
            teardown: "echo teardown:db",
          },
          build: "echo db",
        },
        cwd: ".",
      })

      const api = task({
        name: "api",
        commands: {
          dev: {
            run: "echo api",
            teardown: "echo teardown:api",
          },
          build: "echo api",
        },
        cwd: ".",
        dependencies: [db], // api depends on db
      })

      const mockSpawn = createMockSpawn({
        commands: [
          {
            match: "teardown:api",
            handler: {
              onSpawn: () => {
                teardownOrder.push("api")
              },
            },
          },
          {
            match: "teardown:db",
            handler: {
              onSpawn: () => {
                teardownOrder.push("db")
              },
            },
          },
        ],
      })

      const pipe = pipeline([db, api])
      const result = await pipe.run({
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)

      // api should be torn down before db (reverse dependency order)
      assert.strictEqual(
        teardownOrder.length,
        2,
        "Both teardowns should execute"
      )
      assert.strictEqual(
        teardownOrder[0],
        "api",
        "api (dependent) should be torn down first"
      )
      assert.strictEqual(
        teardownOrder[1],
        "db",
        "db (dependency) should be torn down after api"
      )
    })
  })

  describe("skip", () => {
    it("skips task when command does not exist", async () => {
      let skippedCalled = false
      const task1 = task({
        name: "task1",
        commands: {
          dev: "echo task1",
          // No build command
        },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, mode) => {
          assert.strictEqual(taskName, "task1")
          assert.strictEqual(mode, "build")
          skippedCalled = true
        },
      })

      assert.ok(skippedCalled, "onTaskSkipped should be called")
      assert.strictEqual(
        mockSpawn.mock.calls.length,
        0,
        "No command should be executed"
      )

      // Check result
      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.status, "success")
      assert.strictEqual(result.stats.summary.skipped, 1)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "skipped")
      assert.strictEqual(taskStats.command, "build")
    })

    it("skipped task satisfies dependencies", async () => {
      const executionOrder: string[] = []
      const task1 = task({
        name: "task1",
        commands: {
          dev: "echo task1",
          // No build command
        },
        cwd: ".",
      })

      const task2 = task({
        name: "task2",
        commands: {
          build: "echo task2",
          dev: "echo task2",
        },
        cwd: ".",
        dependencies: [task1],
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1, task2])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskBegin: (taskName) => {
          executionOrder.push(`begin:${taskName}`)
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)
      assert.strictEqual(result.stats.summary.completed, 1)

      // task1 should be skipped, task2 should run
      assert.ok(executionOrder.includes("begin:task2"), "task2 should run")
    })

    it("fails in strict mode when command does not exist", async () => {
      const task1 = task({
        name: "task1",
        commands: {
          dev: "echo task1",
          // No build command
        },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        strict: true,
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, false)
      assert.ok(result.error)
      assert.ok(result.error instanceof PipelineError)
      assert.strictEqual(result.error.code, PipelineError.TaskFailed)
      assert.ok(
        result.error.message.includes("strict mode"),
        "Error should mention strict mode"
      )
      assert.strictEqual(result.stats.status, "failed")

      // Check task stats
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "failed")
      assert.strictEqual(taskStats.command, "build")
    })

    it("allows skip in strict mode with allowSkip", async () => {
      let skippedCalled = false
      const task1 = task({
        name: "task1",
        commands: {
          dev: "echo task1",
          // No build command
        },
        cwd: ".",
        allowSkip: true,
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        strict: true,
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, mode) => {
          assert.strictEqual(taskName, "task1")
          assert.strictEqual(mode, "build")
          skippedCalled = true
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "skipped")

      assert.ok(skippedCalled, "onTaskSkipped should be called")
      assert.strictEqual(
        mockSpawn.mock.calls.length,
        0,
        "No command should be executed"
      )
    })

    it("nested pipeline skips when all inner tasks are skipped", async () => {
      let outerSkipped = false
      const innerTask1 = task({
        name: "inner1",
        commands: {
          dev: "echo inner1",
          // No build command
        },
        cwd: ".",
      })

      const innerTask2 = task({
        name: "inner2",
        commands: {
          dev: "echo inner2",
          // No build command
        },
        cwd: ".",
      })

      const innerPipeline = pipeline([innerTask1, innerTask2])
      const outerTask = innerPipeline.toTask({ name: "outer" })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([outerTask])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, _mode) => {
          if (taskName === "outer") {
            outerSkipped = true
          }
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "skipped")

      assert.ok(
        outerSkipped,
        "Outer task should be skipped when all inner tasks are skipped"
      )
      assert.strictEqual(
        mockSpawn.mock.calls.length,
        0,
        "No commands should be executed"
      )
    })

    it("nested pipeline completes when some inner tasks run", async () => {
      let outerCompleted = false
      const innerTask1 = task({
        name: "inner1",
        commands: {
          dev: "echo inner1",
          build: "echo inner1",
        },
        cwd: ".",
      })

      const innerTask2 = task({
        name: "inner2",
        commands: {
          dev: "echo inner2",
          // No build command
        },
        cwd: ".",
      })

      const innerPipeline = pipeline([innerTask1, innerTask2])
      const outerTask = innerPipeline.toTask({ name: "outer" })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([outerTask])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskComplete: (taskName) => {
          if (taskName === "outer") {
            outerCompleted = true
          }
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.completed, 1)
      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.status, "completed")

      assert.ok(
        outerCompleted,
        "Outer task should complete when some inner tasks run"
      )
    })
  })
})

describe("pipeline <-> task conversion", () => {
  it("converts pipelines to tasks", async () => {
    const executionOrder: string[] = []

    // Mock spawn to track execution
    const mockSpawn = createMockSpawn()

    // Create individual pipelines with mock spawn
    const buildTask1 = task({
      name: "build:compile",
      commands: { dev: "echo build:compile", build: "echo build:compile" },
      cwd: ".",
    })
    const buildTask2 = task({
      name: "build:bundle",
      commands: { dev: "echo build:bundle", build: "echo build:bundle" },
      cwd: ".",
      dependencies: [buildTask1],
    })
    const build = pipeline([buildTask1, buildTask2])

    const testTask1 = task({
      name: "test:unit",
      commands: { dev: "echo test:unit", build: "echo test:unit" },
      cwd: ".",
    })
    const test = pipeline([testTask1])

    const deployTask1 = task({
      name: "deploy:upload",
      commands: { dev: "echo deploy:upload", build: "echo deploy:upload" },
      cwd: ".",
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
        cwd: ".",
      }),
    ])

    const test = pipeline([
      task({
        name: "test",
        commands: { dev: "echo test", build: "echo test" },
        cwd: ".",
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

describe("stats field validation", () => {
  describe("successful pipeline", () => {
    it("includes all required PipelineStats fields", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
        cwd: ".",
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
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = Object.values(result.stats.tasks)[0]

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
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = Object.values(result.stats.tasks)[0]

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
        cwd: ".",
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
      const taskStats = Object.values(result.stats.tasks)[0]
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

      const taskStats = Object.values(result.stats.tasks)[0]
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
        cwd: ".",
      })

      const mockSpawn = mock.fn((_command: string) => {
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

      const taskStats = Object.values(result.stats.tasks)[0]
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
        cwd: ".",
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "sleep 1", build: "sleep 1" },
        cwd: ".",
        dependencies: [task1],
      })

      const mockSpawn = mock.fn((_command: string) => {
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
      const taskStats = Object.values(result.stats.tasks)
      assert.ok(taskStats.length > 0)
      // At least one task should have been affected (aborted or failed status)
      const affectedTasks = taskStats.filter(
        (t) => t.status === "aborted" || t.status === "failed"
      )
      assert.ok(
        affectedTasks.length > 0 || result.stats.summary.running > 0,
        `At least one task should be affected. Summary: ${JSON.stringify(result.stats.summary)}, Task statuses: ${taskStats.map((t) => t.status).join(", ")}`
      )
    })

    it("marks running tasks as aborted with proper fields", async () => {
      const abortController = new AbortController()
      const task1 = task({
        name: "task1",
        commands: { dev: "sleep 1", build: "sleep 1" },
        cwd: ".",
      })

      const mockSpawn = mock.fn((_command: string) => {
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

      const taskStats = Object.values(result.stats.tasks)[0]
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
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)

      const taskStats = Object.values(result.stats.tasks)[0]
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
        cwd: ".",
      })
      const task2 = task({
        name: "task2",
        commands: {
          dev: "echo task2",
          // No build command - will be skipped
        },
        cwd: ".",
        dependencies: [task1],
      })
      const task3 = task({
        name: "task3",
        commands: { dev: "echo task3", build: "echo task3" },
        cwd: ".",
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
      const task1Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task1"
      )!
      assert.strictEqual(task1Stats.status, "completed")
      assert.strictEqual(task1Stats.exitCode, 0)

      // Verify task2 (skipped)
      const task2Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task2"
      )!
      assert.strictEqual(task2Stats.status, "skipped")
      assert.strictEqual(task2Stats.command, "build")

      // Verify task3 (failed)
      const task3Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task3"
      )!
      assert.strictEqual(task3Stats.status, "failed")
      assert.strictEqual(task3Stats.exitCode, 1)
      assert.ok(task3Stats.error instanceof Error)
    })

    it("includes dependencies and dependents for all tasks", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
        cwd: ".",
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "echo task2", build: "echo task2" },
        cwd: ".",
        dependencies: [task1],
      })
      const task3 = task({
        name: "task3",
        commands: { dev: "echo task3", build: "echo task3" },
        cwd: ".",
        dependencies: [task1],
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1, task2, task3])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const task1Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task1"
      )!
      const task2Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task2"
      )!
      const task3Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task3"
      )!

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
        cwd: ".",
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

      const taskStats = Object.values(result.stats.tasks)[0]
      assert.ok(taskStats.teardown !== undefined)
      assert.strictEqual(taskStats.teardown!.status, "failed")
      assert.ok(taskStats.teardown!.error instanceof Error)
    })

    it("does not include teardown for tasks without teardown command", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
        cwd: ".",
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({ spawn: mockSpawn as any })

      const taskStats = Object.values(result.stats.tasks)[0]
      assert.strictEqual(taskStats.teardown, undefined)
    })
  })

  describe("pending tasks", () => {
    it("includes pending status for tasks that never started", async () => {
      const task1 = task({
        name: "task1",
        commands: { dev: "echo task1", build: "echo task1" },
        cwd: ".",
      })
      const task2 = task({
        name: "task2",
        commands: { dev: "echo task2", build: "echo task2" },
        cwd: ".",
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

      const task2Stats = Object.values(result.stats.tasks).find(
        (t) => t.name === "task2"
      )!
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
