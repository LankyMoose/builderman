import type { TaskGraph } from "./types.js"

export type SchedulerInput =
  | { type: "complete"; taskId: number }
  | { type: "ready"; taskId: number }
  | { type: "skip"; taskId: number }

export type SchedulerOutput = { type: "run"; taskId: number } | { type: "idle" }

export function* createScheduler(
  graph: TaskGraph
): Generator<SchedulerOutput, { type: "done" }, SchedulerInput> {
  const remainingReadyDeps = new Map<number, number>()
  const readyTasks = new Set<number>() // Track which tasks are already ready
  const runnable: number[] = []
  let completed = 0

  for (const [id, node] of graph.nodes) {
    remainingReadyDeps.set(id, node.dependencies.size)
    if (node.dependencies.size === 0) {
      runnable.push(id)
    }
  }

  const markDependencyReady = (taskId: number) => {
    if (readyTasks.has(taskId)) {
      return // Already marked as ready, don't double-count
    }
    readyTasks.add(taskId)

    // A dependency became ready, check if dependents can now run
    const node = graph.nodes.get(taskId)!
    for (const depId of node.dependents) {
      const next = (remainingReadyDeps.get(depId) ?? 0) - 1
      remainingReadyDeps.set(depId, next)
      if (next === 0) runnable.push(depId)
    }
  }

  while (completed < graph.nodes.size) {
    if (runnable.length > 0) {
      yield { type: "run", taskId: runnable.shift()! }
      continue
    }

    const input = yield { type: "idle" }

    if (input?.taskId === undefined) continue

    markDependencyReady(input.taskId)
    if (input.type === "ready") continue
    completed++
  }

  return { type: "done" }
}
