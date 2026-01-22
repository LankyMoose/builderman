import assert from "node:assert"
import { describe, it } from "node:test"

import { $TASK_INTERNAL } from "../internal/constants.js"
import { createTaskGraph } from "../internal/graph.js"
import { task } from "../task.js"

describe("createTaskGraph", () => {
  it("creates nodes for all tasks", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
    })

    const graph = createTaskGraph([task1, task2], "dev")

    assert.strictEqual(graph.nodes.size, 2)
    assert.ok(graph.nodes.has(task1[$TASK_INTERNAL].id))
    assert.ok(graph.nodes.has(task2[$TASK_INTERNAL].id))
  })

  it("builds dependency relationships", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: { run: "echo 2", dependencies: [task1] },
        build: { run: "echo 2", dependencies: [task1] },
      },
    })

    const graph = createTaskGraph([task1, task2], "dev")
    const node1 = graph.nodes.get(task1[$TASK_INTERNAL].id)!
    const node2 = graph.nodes.get(task2[$TASK_INTERNAL].id)!

    assert.strictEqual(node1.dependencies.size, 0)
    assert.strictEqual(node1.dependents.size, 1)
    assert.ok(node1.dependents.has(task2[$TASK_INTERNAL].id))

    assert.strictEqual(node2.dependencies.size, 1)
    assert.ok(node2.dependencies.has(task1[$TASK_INTERNAL].id))
    assert.strictEqual(node2.dependents.size, 0)
  })

  it("includes transitive dependencies automatically", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: { run: "echo 2", dependencies: [task1] },
        build: { run: "echo 2", dependencies: [task1] },
      },
    })

    // task2 depends on task1, but task1 is not explicitly in the pipeline
    // It should be automatically included as a transitive dependency
    const graph = createTaskGraph([task2], "dev")
    
    // Both tasks should be in the graph
    assert.strictEqual(graph.nodes.size, 2)
    assert.ok(graph.nodes.has(task1[$TASK_INTERNAL].id))
    assert.ok(graph.nodes.has(task2[$TASK_INTERNAL].id))
    
    // task2 should depend on task1
    const node2 = graph.nodes.get(task2[$TASK_INTERNAL].id)!
    assert.ok(node2.dependencies.has(task1[$TASK_INTERNAL].id))
  })
})

describe("TaskGraph.validate", () => {
  it("validates graph without cycles", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
    })

    const graph = createTaskGraph([task1, task2], "dev")
    assert.doesNotThrow(() => graph.validate())
  })

  it("detects simple circular dependency", () => {
    const task1 = task({
      name: "task1",
      commands: {
        dev: { run: "echo 1", dependencies: [] },
        build: "echo 1",
      },
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: { run: "echo 2", dependencies: [task1] },
        build: "echo 2",
      },
    })
    // Create circular dependency: task1 -> task2 -> task1
    // Manually create the cycle by modifying task1's dev command
    const task1Dev = task1[$TASK_INTERNAL].commands["dev"] as any
    if (task1Dev && typeof task1Dev !== "string") {
      task1Dev.dependencies = [task2]
    }
    const graph = createTaskGraph([task1, task2], "dev")
    assert.throws(() => graph.validate(), /Circular dependency detected/)
  })

  it("detects longer circular dependency chain", () => {
    const task3 = task({
      name: "task3",
      commands: {
        dev: { run: "echo 3", dependencies: [] },
        build: "echo 3",
      },
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: { run: "echo 2", dependencies: [task3] },
        build: "echo 2",
      },
    })
    const task1 = task({
      name: "task1",
      commands: {
        dev: { run: "echo 1", dependencies: [task2] },
        build: "echo 1",
      },
    })
    // Create cycle: task1 -> task2 -> task3 -> task1
    // Manually create the cycle by modifying task3's dev command
    const task3Dev = task3[$TASK_INTERNAL].commands["dev"] as any
    if (task3Dev && typeof task3Dev !== "string") {
      task3Dev.dependencies = [task1]
    }
    const graph = createTaskGraph([task1, task2, task3], "dev")
    // Validate BEFORE simplify, because simplify might remove edges that are part of cycles
    assert.throws(() => graph.validate(), /Circular dependency detected/)
  })
})

describe("TaskGraph.simplify", () => {
  it("removes transitive dependencies", () => {
    const task1 = task({
      name: "task1",
      commands: { dev: "echo 1", build: "echo 1" },
    })
    const task2 = task({
      name: "task2",
      commands: {
        dev: { run: "echo 2", dependencies: [task1] },
        build: "echo 2",
      },
    })
    // task3 depends on both task1 and task2, but task2 already depends on task1
    // So task3 -> task1 is transitive
    const task3 = task({
      name: "task3",
      commands: {
        dev: { run: "echo 3", dependencies: [task1, task2] },
        build: "echo 3",
      },
    })

    const graph = createTaskGraph([task1, task2, task3], "dev")
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
    })
    const task2 = task({
      name: "task2",
      commands: { dev: "echo 2", build: "echo 2" },
    })
    // task3 depends on both task1 and task2, but they're independent
    const task3 = task({
      name: "task3",
      commands: {
        dev: { run: "echo 3", dependencies: [task1, task2] },
        build: "echo 3",
      },
    })

    const graph = createTaskGraph([task1, task2, task3], "dev")
    graph.simplify()

    const node3 = graph.nodes.get(task3[$TASK_INTERNAL].id)!
    // Both dependencies should remain
    assert.strictEqual(node3.dependencies.size, 2)
    assert.ok(node3.dependencies.has(task1[$TASK_INTERNAL].id))
    assert.ok(node3.dependencies.has(task2[$TASK_INTERNAL].id))
  })
})
