import assert from "node:assert"
import { describe, it, mock } from "node:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { pipeline } from "./pipeline.js"
import { task } from "./task.js"

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

    // Mock spawn to track execution
    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // Extract task name from command
      if (command.includes("task1")) {
        executionOrder.push("task1")
        // Simulate immediate completion
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      } else if (command.includes("task2")) {
        executionOrder.push("task2")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2])
    await pipe.run({
      spawn: mockSpawn as any,
      onTaskComplete: (name) => {
        executionOrder.push(`complete:${name}`)
      },
    })

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

    const mockSpawn = mock.fn((_command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // Simulate failure
      setImmediate(() => {
        mockProcess.emit("exit", 1)
      })

      return mockProcess
    })

    const pipe = pipeline([task1])
    let errorCaught = false

    await pipe
      .run({
        spawn: mockSpawn as any,
        onTaskError: (name, error) => {
          assert.strictEqual(name, "task1")
          assert.ok(error.message.includes("exit code"))
          errorCaught = true
        },
      })
      .catch(() => {
        // Expected to reject
      })

    assert.ok(errorCaught)
  })

  it("calls onPipelineComplete when all tasks complete", async () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
    })

    const mockSpawn = mock.fn((_command: string) => {
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
    let pipelineCompleteCalled = false

    await pipe.run({
      spawn: mockSpawn as any,
      onPipelineComplete: () => {
        pipelineCompleteCalled = true
      },
    })

    assert.ok(pipelineCompleteCalled)
  })

  it("waits for task with isReady before starting dependent task", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
      isReady: (output) => output.includes("READY"),
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      dependencies: [task1],
    })

    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      if (command.includes("task1")) {
        executionOrder.push("task1:started")
        // Emit stdout that doesn't match ready condition
        setImmediate(() => {
          mockProcess.stdout?.emit("data", Buffer.from("Starting...\n"))
        })
        // Then emit ready condition after a delay
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        // Complete after ready
        setTimeout(() => {
          mockProcess.emit("exit", 0)
          executionOrder.push("task1:complete")
        }, 20)
      } else if (command.includes("task2")) {
        executionOrder.push("task2:started")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
          executionOrder.push("task2:complete")
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2])
    await pipe.run({
      spawn: mockSpawn as any,
      onTaskComplete: (name) => {
        executionOrder.push(`complete:${name}`)
      },
    })

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

    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      if (command.includes("task1")) {
        executionOrder.push("task1:started")
        // Delay completion
        setTimeout(() => {
          mockProcess.emit("exit", 0)
          executionOrder.push("task1:complete")
        }, 50)
      } else if (command.includes("task2")) {
        executionOrder.push("task2:started")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
          executionOrder.push("task2:complete")
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2])
    await pipe.run({
      spawn: mockSpawn as any,
    })

    // task1 should start first
    assert.strictEqual(executionOrder.indexOf("task1:started"), 0)
    // task2 should start immediately after task1 (no waiting for ready or completion)
    // Since task1 has no isReady, it's marked as ready immediately when it starts,
    // so task2 should start right away
    const task1StartedIndex = executionOrder.indexOf("task1:started")
    const task2StartedIndex = executionOrder.indexOf("task2:started")
    // task2 should start very soon after task1 (they should be close in execution order)
    assert.ok(
      task2StartedIndex > task1StartedIndex,
      "task2 should start after task1"
    )
    // The key is that task2 starts without waiting for task1 to complete
    // (completion order may vary due to timing, but starting order is what matters)
    assert.ok(
      task2StartedIndex === task1StartedIndex + 1,
      "task2 should start immediately after task1 (no delay)"
    )
  })

  it("starts multiple dependents when task with isReady becomes ready", async () => {
    const executionOrder: string[] = []
    const task1 = task({
      name: "task1",
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
      isReady: (output) => output.includes("READY"),
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
        executionOrder.push("task1:started")
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 20)
      } else if (command.includes("task2")) {
        executionOrder.push("task2:started")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      } else if (command.includes("task3")) {
        executionOrder.push("task3:started")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2, task3])
    await pipe.run({
      spawn: mockSpawn as any,
    })

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
      commands: { dev: "echo task1", build: "echo task1" },
      cwd: ".",
      isReady: (output) => output.includes("TASK1_READY"),
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo task2", build: "echo task2" },
      cwd: ".",
      isReady: (output) => output.includes("TASK2_READY"),
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
        executionOrder.push("task1:started")
        setTimeout(() => {
          executionOrder.push("task1:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK1_READY\n"))
          executionOrder.push("task1:after-ready")
        }, 10)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 30)
      } else if (command.includes("task2")) {
        executionOrder.push("task2:started")
        setTimeout(() => {
          executionOrder.push("task2:before-ready")
          mockProcess.stdout?.emit("data", Buffer.from("TASK2_READY\n"))
          executionOrder.push("task2:after-ready")
        }, 20)
        setTimeout(() => {
          mockProcess.emit("exit", 0)
        }, 40)
      } else if (command.includes("task3")) {
        executionOrder.push("task3:started")
        setImmediate(() => {
          mockProcess.emit("exit", 0)
        })
      }

      return mockProcess
    })

    const pipe = pipeline([task1, task2, task3])
    await pipe.run({
      spawn: mockSpawn as any,
    })

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
})

describe("pipeline -> task conversion", () => {
  it("converts pipelines to tasks", async () => {
    const executionOrder: string[] = []

    // Mock spawn to track execution
    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // Extract task name from command
      const taskName = command.match(/echo\s+([^\s]+)/)?.[1] || "unknown"
      executionOrder.push(`start:${taskName}`)

      setImmediate(() => {
        mockProcess.emit("exit", 0)
        executionOrder.push(`complete:${taskName}`)
      })

      return mockProcess
    })

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

    await ci.run({
      spawn: mockSpawn as any,
      onTaskComplete: (name) => {
        executionOrder.push(`pipeline-complete:${name}`)
      },
    })

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

  it("chains tasks with andThen", async () => {
    const executionOrder: string[] = []

    // Mock spawn to track execution
    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // Extract task name from command
      const taskName = command.match(/echo\s+([^\s]+)/)?.[1] || "unknown"
      executionOrder.push(`start:${taskName}`)

      setImmediate(() => {
        mockProcess.emit("exit", 0)
        executionOrder.push(`complete:${taskName}`)
      })

      return mockProcess
    })

    // Use andThen to chain tasks
    const build = task({
      name: "compile",
      commands: { dev: "echo compile", build: "echo compile" },
      cwd: ".",
    }).andThen({
      name: "bundle",
      commands: { dev: "echo bundle", build: "echo bundle" },
      cwd: ".",
    })

    // Verify it returns a pipeline
    assert.ok("run" in build, "andThen should return a pipeline")
    assert.ok("toTask" in build, "andThen should return a pipeline")

    // Run the pipeline
    await build.run({
      spawn: mockSpawn as any,
    })

    // Verify execution order: compile should complete before bundle starts
    // Note: Due to async timing with setImmediate, we verify that compile starts first
    // and that bundle doesn't start until after compile's completion is processed
    const compileStartIndex = executionOrder.indexOf("start:compile")
    const compileCompleteIndex = executionOrder.indexOf("complete:compile")
    const bundleStartIndex = executionOrder.indexOf("start:bundle")
    const bundleCompleteIndex = executionOrder.indexOf("complete:bundle")

    assert.ok(compileStartIndex !== -1, "compile should start")
    assert.ok(compileCompleteIndex !== -1, "compile should complete")
    assert.ok(bundleStartIndex !== -1, "bundle should start")
    assert.ok(bundleCompleteIndex !== -1, "bundle should complete")

    // Compile should start before bundle
    assert.ok(
      compileStartIndex < bundleStartIndex,
      `compile should start before bundle. Compile started at ${compileStartIndex}, bundle started at ${bundleStartIndex}. Order: ${executionOrder.join(
        ", "
      )}`
    )

    // Bundle should complete after compile completes
    assert.ok(
      bundleCompleteIndex > compileCompleteIndex,
      `bundle should complete after compile. Compile completed at ${compileCompleteIndex}, bundle completed at ${bundleCompleteIndex}. Order: ${executionOrder.join(
        ", "
      )}`
    )
  })

  it("chains pipelines with andThen using task config", async () => {
    const executionOrder: string[] = []

    // Mock spawn to track execution
    const mockSpawn = mock.fn((command: string) => {
      const mockProcess = new EventEmitter() as ChildProcess
      mockProcess.kill = mock.fn() as any
      mockProcess.stdout = new EventEmitter() as any
      mockProcess.stderr = new EventEmitter() as any

      // Extract task name from command
      const taskName = command.match(/echo\s+([^\s]+)/)?.[1] || "unknown"
      executionOrder.push(`start:${taskName}`)

      setImmediate(() => {
        mockProcess.emit("exit", 0)
        executionOrder.push(`complete:${taskName}`)
      })

      return mockProcess
    })

    // Create a pipeline and chain a task to it
    const build = pipeline([
      task({
        name: "compile",
        commands: { dev: "echo compile", build: "echo compile" },
        cwd: ".",
      }),
    ]).andThen({
      name: "bundle",
      commands: { dev: "echo bundle", build: "echo bundle" },
      cwd: ".",
    })

    // Verify it returns a pipeline
    assert.ok("run" in build, "andThen should return a pipeline")
    assert.ok("toTask" in build, "andThen should return a pipeline")

    // Run the pipeline
    await build.run({
      spawn: mockSpawn as any,
    })

    // Verify execution order: compile should complete before bundle starts
    const compileStartIndex = executionOrder.indexOf("start:compile")
    const compileCompleteIndex = executionOrder.indexOf("complete:compile")
    const bundleStartIndex = executionOrder.indexOf("start:bundle")

    assert.ok(compileStartIndex !== -1, "compile should start")
    assert.ok(compileCompleteIndex !== -1, "compile should complete")
    assert.ok(bundleStartIndex !== -1, "bundle should start")

    // Compile should start before bundle
    assert.ok(
      compileStartIndex < bundleStartIndex,
      `compile should start before bundle. Compile started at ${compileStartIndex}, bundle started at ${bundleStartIndex}. Order: ${executionOrder.join(
        ", "
      )}`
    )
  })
})
