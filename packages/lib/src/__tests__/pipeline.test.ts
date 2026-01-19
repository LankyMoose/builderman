import assert from "node:assert"
import { describe, it, mock } from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { $TASK_INTERNAL } from "../internal/constants.js"
import { pipeline } from "../pipeline.js"
import { PipelineError } from "../errors.js"
import { task } from "../task.js"
import { createMockSpawn } from "./helpers.js"

describe("pipeline", () => {
  it("validates graph on creation", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
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
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
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
    const taskStats = result.stats.tasks[0]
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
    const taskStats = result.stats.tasks[0]
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
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      dependencies: [task1],
    })

    const mockSpawn = createMockSpawn({
      commandHandler: (cmd, args, process) => {
        const commandString = [cmd, ...args].join(" ")
        if (commandString.includes("task1")) {
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
        } else if (commandString.includes("task2")) {
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

  it("waits for dependency to complete when task has no readyWhen", async () => {
    const executionOrder: string[] = []
    const task1StartTime: number[] = []
    const task1CompleteTime: number[] = []
    const task2StartTime: number[] = []

    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
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
        const timestamp = Date.now()
        executionOrder.push(`${name}:started`)
        if (name === "task1") {
          task1StartTime.push(timestamp)
        } else if (name === "task2") {
          task2StartTime.push(timestamp)
        }
      },
      onTaskComplete: (name) => {
        const timestamp = Date.now()
        executionOrder.push(`${name}:completed`)
        if (name === "task1") {
          task1CompleteTime.push(timestamp)
        }
      },
    })

    assert.strictEqual(result.ok, true)

    // task1 should start first
    assert.strictEqual(executionOrder.indexOf("task1:started"), 0)
    // task1 should complete before task2 starts
    // When there's no readyWhen, dependent tasks must wait for the dependency to exit successfully
    const task1CompletedIndex = executionOrder.indexOf("task1:completed")
    const task2StartedIndex = executionOrder.indexOf("task2:started")

    assert.ok(
      task1CompletedIndex < task2StartedIndex,
      "task1 should complete before task2 starts when there's no readyWhen"
    )

    // Verify timing: task2 should start after task1 completes (allowing some timing variance)
    if (task1CompleteTime.length > 0 && task2StartTime.length > 0) {
      const timeDiff = task2StartTime[0] - task1CompleteTime[0]
      assert.ok(
        timeDiff >= -10, // Allow 10ms variance for async scheduling
        `task2 should start after task1 completes. task1 completed at ${task1CompleteTime[0]}, task2 started at ${task2StartTime[0]}, diff: ${timeDiff}ms`
      )
    }
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

    const mockSpawn = mock.fn((cmd: string, args: string[] = []) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      const commandString = [cmd, ...args].join(" ")
      if (commandString.includes("task1")) {
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 20)
      } else if (commandString.includes("task2")) {
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      } else if (commandString.includes("task3")) {
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
    })
    const task3 = task({
      name: "task3",
      commands: { dev: "echo task3", build: "echo task3" },
      dependencies: [task1, task2],
    })

    const mockSpawn = mock.fn((cmd: string, args: string[] = []) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      const commandString = [cmd, ...args].join(" ")
      if (commandString.includes("task1")) {
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK1_READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 30)
      } else if (commandString.includes("task2")) {
        setTimeout(() => {
          executionOrder.push("task2:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK2_READY\n"))
          executionOrder.push("task2:after-ready")
        }, 20)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 40)
      } else if (commandString.includes("task3")) {
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

  it("fails task when readyWhen condition is not met within readyTimeout", async () => {
    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo starting",
          readyWhen: (output) => output.includes("READY"),
          readyTimeout: 50,
        },
        build: "echo task1",
      },
    })

    const mockSpawn = createMockSpawn({
      commandHandler: (cmd, args, process) => {
        const commandString = [cmd, ...args].join(" ")
        if (commandString.includes("task1")) {
          // Emit stdout that doesn't match ready condition
          setImmediate(() => {
            process.stdout?.emit("data", Buffer.from("Starting...\n"))
          })
          // Never emit "READY", so timeout should fire
          // Don't emit exit - the timeout should kill it
        }
      },
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
    })

    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.TaskReadyTimeout)
    assert.ok(
      result.error.message.includes("Task did not become ready within 50ms"),
      `Error message should mention timeout. Got: ${result.error.message}`
    )
    assert.ok(
      result.error.message.includes("task1"),
      `Error message should include task name. Got: ${result.error.message}`
    )

    // Check task stats
    const task1Stats = result.stats.tasks.find((t) => t.name === "task1")!
    assert.strictEqual(task1Stats.status, "failed")
    assert.ok(task1Stats.startedAt !== undefined)
    assert.ok(task1Stats.finishedAt !== undefined)
    assert.ok(task1Stats.durationMs !== undefined)
    assert.ok(task1Stats.error !== undefined)
    assert.strictEqual(task1Stats.error?.message, result.error.message)
  })

  it("fails task when task does not complete within completedTimeout", async () => {
    const task1 = task({
      name: "task1",
      commands: {
        dev: {
          run: "echo starting",
          completedTimeout: 50,
        },
        build: "echo task1",
      },
    })

    const mockSpawn = createMockSpawn({
      commandHandler: (cmd, args, process) => {
        const commandString = [cmd, ...args].join(" ")
        if (commandString.includes("task1")) {
          // Emit some stdout but never exit - the timeout should kill it
          setImmediate(() => {
            process.stdout?.emit("data", Buffer.from("Starting...\n"))
          })
          // Don't emit exit - the timeout should kill it and handle everything
          // The timeout handler will remove from runningTasks and call failPipeline
        }
      },
    })

    const pipe = pipeline([task1])
    const result = await pipe.run({
      spawn: mockSpawn as any,
    })

    assert.strictEqual(result.ok, false)
    assert.ok(result.error)
    assert.strictEqual(result.error.code, PipelineError.TaskCompletedTimeout)
    assert.ok(
      result.error.message.includes("Task did not complete within 50ms"),
      `Error message should mention timeout. Got: ${result.error.message}`
    )
    assert.ok(
      result.error.message.includes("task1"),
      `Error message should include task name. Got: ${result.error.message}`
    )

    // Check task stats
    const task1Stats = result.stats.tasks.find((t) => t.name === "task1")!
    assert.strictEqual(task1Stats.status, "failed")
    assert.ok(task1Stats.startedAt !== undefined)
    assert.ok(task1Stats.finishedAt !== undefined)
    assert.ok(task1Stats.durationMs !== undefined)
    assert.ok(task1Stats.error !== undefined)
    assert.strictEqual(task1Stats.error?.message, result.error.message)
  })

  it("cancels pipeline when abort signal is triggered", async () => {
    const abortController = new AbortController()
    let taskKilled = false

    const task1 = task({
      name: "task1",
      commands: { dev: "sleep 1", build: "sleep 1" },
    })

    const task2 = task({
      name: "task2",
      commands: { dev: "sleep 1", build: "sleep 1" },
      dependencies: [task1], // task2 depends on task1, so it starts after task1 completes
    })

    let spawnCallCount = 0
    let task2Started = false

    const mockSpawn = mock.fn((_cmd: string, _args: string[] = []) => {
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
      const taskStats = result.stats.tasks[0]
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
      const taskStats = result.stats.tasks[0]
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
      })

      const mockSpawn = mock.fn((cmd: string, args: string[] = []) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        const commandString = [cmd, ...args].join(" ")
        if (commandString.includes("teardown")) {
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
      const taskStats = result.stats.tasks[0]
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
      const taskStats = result.stats.tasks[0]
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
      const taskStats = result.stats.tasks[0]
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
        dependencies: [task1],
      })

      const mockSpawn = mock.fn((cmd: string, args: string[] = []) => {
        const mockProcess = new EventEmitter() as ChildProcess
        mockProcess.kill = mock.fn() as any
        mockProcess.stdout = new EventEmitter() as any
        mockProcess.stderr = new EventEmitter() as any

        const commandString = [cmd, ...args].join(" ")
        if (commandString.includes("task2")) {
          task2Spawned = true
        }

        if (commandString.includes("teardown2")) {
          task2TeardownExecuted = true
          setImmediate(() => {
            mockProcess.emit("exit", 0)
          })
        } else if (commandString.includes("task1")) {
          // task1 fails immediately
          setImmediate(() => {
            mockProcess.emit("exit", 1)
          })
        } else if (
          commandString.includes("teardown") &&
          !commandString.includes("teardown2")
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
      const task2Stats = result.stats.tasks.find((t) => t.name === "task2")
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
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, _taskId, mode) => {
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
      const taskStats = result.stats.tasks[0]
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
      })

      const task2 = task({
        name: "task2",
        commands: {
          build: "echo task2",
          dev: "echo task2",
        },
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
      const taskStats = result.stats.tasks[0]
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
        allowSkip: true,
      })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        strict: true,
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, _taskId, mode) => {
          assert.strictEqual(taskName, "task1")
          assert.strictEqual(mode, "build")
          skippedCalled = true
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)
      const taskStats = result.stats.tasks[0]
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
      })

      const innerTask2 = task({
        name: "inner2",
        commands: {
          dev: "echo inner2",
          // No build command
        },
      })

      const innerPipeline = pipeline([innerTask1, innerTask2])
      const outerTask = innerPipeline.toTask({ name: "outer" })

      const mockSpawn = createMockSpawn()

      const pipe = pipeline([outerTask])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
        onTaskSkipped: (taskName, _taskId, _mode) => {
          if (taskName === "outer") {
            outerSkipped = true
          }
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)
      const taskStats = result.stats.tasks[0]
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
      })

      const innerTask2 = task({
        name: "inner2",
        commands: {
          dev: "echo inner2",
          // No build command
        },
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
      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "completed")

      assert.ok(
        outerCompleted,
        "Outer task should complete when some inner tasks run"
      )
    })
  })

  describe("maxConcurrency", () => {
    it("limits the number of concurrent tasks", async () => {
      const taskStartTimes: Map<string, number> = new Map()
      const taskCompleteTimes: Map<string, number> = new Map()
      let maxConcurrentTasks = 0
      let currentConcurrentTasks = 0

      // Create 5 independent tasks that can all run in parallel
      const tasks = Array.from({ length: 5 }, (_, i) =>
        task({
          name: `task${i + 1}`,
          commands: { dev: `echo task${i + 1}`, build: `echo task${i + 1}` },
        })
      )

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `task${i + 1}`,
          handler: {
            exitDelay: 50, // Each task takes 50ms to complete
          },
        })),
      })

      const pipe = pipeline(tasks)
      const result = await pipe.run({
        spawn: mockSpawn as any,
        maxConcurrency: 2, // Limit to 2 concurrent tasks
        onTaskBegin: (name) => {
          currentConcurrentTasks++
          maxConcurrentTasks = Math.max(
            maxConcurrentTasks,
            currentConcurrentTasks
          )
          taskStartTimes.set(name, Date.now())
        },
        onTaskComplete: (name) => {
          currentConcurrentTasks--
          taskCompleteTimes.set(name, Date.now())
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.status, "success")
      assert.strictEqual(result.stats.summary.total, 5)
      assert.strictEqual(result.stats.summary.completed, 5)

      // Verify that at most 2 tasks ran concurrently
      assert.strictEqual(
        maxConcurrentTasks,
        2,
        `Expected at most 2 concurrent tasks, but saw ${maxConcurrentTasks}`
      )

      // Verify all tasks started and completed
      assert.strictEqual(
        taskStartTimes.size,
        5,
        "All 5 tasks should have started"
      )
      assert.strictEqual(
        taskCompleteTimes.size,
        5,
        "All 5 tasks should have completed"
      )

      // Verify that tasks started in batches due to concurrency limit
      // With maxConcurrency=2 and 5 tasks, we should see:
      // - First 2 tasks start immediately
      // - After first task completes, 3rd task starts
      // - After second task completes, 4th task starts
      // - After third task completes, 5th task starts
      const startTimes = Array.from(taskStartTimes.values()).sort()
      const completeTimes = Array.from(taskCompleteTimes.values()).sort()

      // The first 2 tasks should start at roughly the same time
      const firstBatchStartDiff = Math.abs(startTimes[0] - startTimes[1])
      assert.ok(
        firstBatchStartDiff < 10,
        "First 2 tasks should start at roughly the same time"
      )

      // The 3rd task should start after one of the first 2 completes
      // (allowing some timing variance)
      const firstCompleteTime = completeTimes[0]
      const thirdStartTime = startTimes[2]
      assert.ok(
        thirdStartTime >= firstCompleteTime - 10,
        "3rd task should start after first task completes"
      )

      // The 5th task should start after the 3rd completes
      const thirdCompleteTime = completeTimes[2]
      const fifthStartTime = startTimes[4]
      assert.ok(
        fifthStartTime >= thirdCompleteTime - 10,
        "5th task should start after 3rd task completes"
      )
    })

    it("allows unlimited concurrency when maxConcurrency is not set", async () => {
      const taskStartTimes: Map<string, number> = new Map()
      let maxConcurrentTasks = 0
      let currentConcurrentTasks = 0

      // Create 5 independent tasks
      const tasks = Array.from({ length: 5 }, (_, i) =>
        task({
          name: `task${i + 1}`,
          commands: { dev: `echo task${i + 1}`, build: `echo task${i + 1}` },
        })
      )

      const mockSpawn = createMockSpawn({
        commands: tasks.map((_, i) => ({
          match: `task${i + 1}`,
          handler: {
            exitDelay: 20,
          },
        })),
      })

      const pipe = pipeline(tasks)
      const result = await pipe.run({
        spawn: mockSpawn as any,
        // maxConcurrency not set - should allow unlimited
        onTaskBegin: (name) => {
          currentConcurrentTasks++
          maxConcurrentTasks = Math.max(
            maxConcurrentTasks,
            currentConcurrentTasks
          )
          taskStartTimes.set(name, Date.now())
        },
        onTaskComplete: () => {
          currentConcurrentTasks--
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.status, "success")
      assert.strictEqual(result.stats.summary.completed, 5)

      // With unlimited concurrency, all 5 tasks should start at roughly the same time
      assert.strictEqual(
        maxConcurrentTasks,
        5,
        "All 5 tasks should run concurrently when maxConcurrency is not set"
      )

      // All tasks should start at roughly the same time
      const startTimes = Array.from(taskStartTimes.values()).sort()
      const timeSpan = startTimes[4] - startTimes[0]
      assert.ok(
        timeSpan < 20,
        "All tasks should start within a short time span when concurrency is unlimited"
      )
    })

    it("respects maxConcurrency with task dependencies", async () => {
      const taskStartTimes: Map<string, number> = new Map()
      let maxConcurrentTasks = 0
      let currentConcurrentTasks = 0

      // Create a dependency chain: task1 -> task2, task3, task4 (all depend on task1)
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

      const task4 = task({
        name: "task4",
        commands: { dev: "echo task4", build: "echo task4" },
        dependencies: [task1],
      })

      const mockSpawn = createMockSpawn({
        commands: [
          { match: "task1", handler: { exitDelay: 30 } },
          { match: "task2", handler: { exitDelay: 30 } },
          { match: "task3", handler: { exitDelay: 30 } },
          { match: "task4", handler: { exitDelay: 30 } },
        ],
      })

      const pipe = pipeline([task1, task2, task3, task4])
      const result = await pipe.run({
        spawn: mockSpawn as any,
        maxConcurrency: 2,
        onTaskBegin: (name) => {
          currentConcurrentTasks++
          maxConcurrentTasks = Math.max(
            maxConcurrentTasks,
            currentConcurrentTasks
          )
          taskStartTimes.set(name, Date.now())
        },
        onTaskComplete: () => {
          currentConcurrentTasks--
        },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.status, "success")

      // task1 should start first (no dependencies)
      // Then task2, task3, task4 should start after task1 completes
      // But with maxConcurrency=2, only 2 of them should run concurrently
      assert.strictEqual(
        maxConcurrentTasks,
        2,
        "At most 2 tasks should run concurrently"
      )

      // Verify task1 starts first
      const task1StartTime = taskStartTimes.get("task1")!
      const task2StartTime = taskStartTimes.get("task2")!
      const task3StartTime = taskStartTimes.get("task3")!
      const task4StartTime = taskStartTimes.get("task4")!

      assert.ok(
        task1StartTime < task2StartTime,
        "task1 should start before task2"
      )
      assert.ok(
        task1StartTime < task3StartTime,
        "task1 should start before task3"
      )
      assert.ok(
        task1StartTime < task4StartTime,
        "task1 should start before task4"
      )

      // Verify that task2, task3, task4 start in batches of 2
      // Two should start at roughly the same time, then the third after one completes
      const dependentStartTimes = [
        task2StartTime,
        task3StartTime,
        task4StartTime,
      ].sort()
      const firstTwoDiff = Math.abs(
        dependentStartTimes[0] - dependentStartTimes[1]
      )
      assert.ok(
        firstTwoDiff < 50,
        `First 2 dependent tasks should start at roughly the same time (diff: ${firstTwoDiff}ms)`
      )

      // The third dependent task should start after one of the first two completes
      // (allowing some timing variance for async scheduling)
      // Since tasks take 30ms to complete, the third should start at least ~30ms after the first
      const timeBetweenSecondAndThird =
        dependentStartTimes[2] - dependentStartTimes[1]
      assert.ok(
        timeBetweenSecondAndThird >= -10,
        `Third dependent task should start after one of the first two completes (diff: ${timeBetweenSecondAndThird}ms)`
      )
    })
  })
})
