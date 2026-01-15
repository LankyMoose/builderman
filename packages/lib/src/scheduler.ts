import type { TaskGraph } from "./types.js"

export type SchedulerInput =
  | { type: "complete"; taskId: number }
  | { type: "ready"; taskId: number }

export type SchedulerOutput =
  | { type: "run"; taskId: number }
  | { type: "idle" }
  | { type: "done" }

export function* createScheduler(
  graph: TaskGraph
): Generator<SchedulerOutput, never, SchedulerInput> {
  const remainingDeps = new Map<number, number>()
  const runnable: number[] = []
  let completed = 0

  for (const [id, node] of graph.nodes) {
    remainingDeps.set(id, node.dependencies.size)
    if (node.dependencies.size === 0) {
      runnable.push(id)
    }
  }

  while (true) {
    if (runnable.length > 0) {
      yield { type: "run", taskId: runnable.shift()! }
      continue
    }

    if (completed === graph.nodes.size) {
      yield { type: "done" }
      continue
    }

    const input = yield { type: "idle" }

    if (input.type === "complete") {
      completed++

      const node = graph.nodes.get(input.taskId)!
      for (const depId of node.dependents) {
        const next = (remainingDeps.get(depId) ?? 0) - 1
        remainingDeps.set(depId, next)
        if (next === 0) runnable.push(depId)
      }
    }
  }
}
