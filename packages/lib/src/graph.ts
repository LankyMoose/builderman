import { $TASK_INTERNAL } from "./constants.js"
import type { TaskNode, TaskGraph, Task } from "./types.js"

export function createTaskGraph(tasks: Task[]): TaskGraph {
  const nodes = new Map<number, TaskNode>()

  // Create nodes for all tasks
  for (const task of tasks) {
    const { id: taskId } = task[$TASK_INTERNAL]
    nodes.set(taskId, {
      task,
      dependencies: new Set(),
      dependents: new Set(),
    })
  }

  // Build dependency relationships
  for (const task of tasks) {
    const { id: taskId, name: taskName, dependencies } = task[$TASK_INTERNAL]
    const node = nodes.get(taskId)!

    for (const dep of dependencies) {
      const { id: depId, name: depName } = dep[$TASK_INTERNAL]
      if (!nodes.has(depId)) {
        throw new Error(
          `Task "${taskName}" depends on "${depName}" which is not in the pipeline`
        )
      }
      node.dependencies.add(depId)
      nodes.get(depId)!.dependents.add(taskId)
    }
  }

  return {
    nodes,
    validate() {
      // Use DFS to detect cycles
      const visited = new Set<number>()
      const recursionStack = new Set<number>()

      const visit = (nodeId: number, path: number[]): void => {
        if (recursionStack.has(nodeId)) {
          // Found a cycle - build the cycle path
          const cycleStart = path.indexOf(nodeId)
          const cycle = [...path.slice(cycleStart), nodeId]
          throw new Error(`Circular dependency detected: ${cycle.join(" -> ")}`)
        }

        if (visited.has(nodeId)) {
          return
        }

        visited.add(nodeId)
        recursionStack.add(nodeId)

        const node = nodes.get(nodeId)!
        for (const depId of node.dependencies) {
          visit(depId, [...path, nodeId])
        }

        recursionStack.delete(nodeId)
      }

      for (const nodeId of nodes.keys()) {
        if (!visited.has(nodeId)) {
          visit(nodeId, [])
        }
      }
    },
    simplify() {
      // Remove transitive dependencies using Floyd-Warshall approach
      // For each node, if there's a path through another node, remove the direct edge
      const reachable = new Map<number, Set<number>>()

      // Initialize reachable sets with direct dependencies
      for (const [id, node] of nodes) {
        reachable.set(id, new Set(node.dependencies))
      }

      // Compute transitive closure
      for (const k of nodes.keys()) {
        for (const i of nodes.keys()) {
          if (reachable.get(i)!.has(k)) {
            for (const j of nodes.keys()) {
              if (reachable.get(k)!.has(j)) {
                reachable.get(i)!.add(j)
              }
            }
          }
        }
      }

      // Remove transitive edges
      for (const [nodeId, node] of nodes) {
        const toRemove = new Set<number>()
        for (const depId of node.dependencies) {
          // Check if there's a path from this node to dep through another dependency
          for (const otherDep of node.dependencies) {
            if (otherDep !== depId && reachable.get(otherDep)!.has(depId)) {
              // dep is reachable through otherDep, so it's transitive
              toRemove.add(depId)
            }
          }
        }
        for (const depId of toRemove) {
          node.dependencies.delete(depId)
          nodes.get(depId)!.dependents.delete(nodeId)
        }
      }
    },
  }
}
