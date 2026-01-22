import { $TASK_INTERNAL } from "./constants.js"
import { PipelineError } from "../errors.js"
import type { TaskNode, TaskGraph, Task, Artifact, CommandCacheConfig } from "../types.js"

/**
 * Internal cache config with artifacts separated from inputs.
 */
type InternalCacheConfig = CommandCacheConfig & {
  artifacts?: Artifact[]
}

/**
 * Creates a task graph from root tasks, including all transitive dependencies.
 *
 * The graph will include all tasks reachable from the root tasks through
 * their dependencies, creating a single global task graph.
 *
 * @param rootTasks - The root tasks to start building the graph from
 * @param command - The command name to use for dependency resolution (e.g., "dev", "build")
 * @param excludeTasks - Optional set of tasks to exclude from the graph (e.g., already-satisfied dependencies)
 */
export function createTaskGraph(
  rootTasks: Task[],
  command: string,
  excludeTasks?: Set<Task>
): TaskGraph {
  const nodes = new Map<string, TaskNode>()
  const allTasks = new Set<Task>()

  // Helper to get dependencies for a task
  const getTaskDependencies = (task: Task): Task[] => {
    const internal = task[$TASK_INTERNAL]
    const deps = new Set<Task>()

    // Check for pipeline-level dependencies (for nested pipeline tasks)
    const anyInternal = internal as any
    const pipelineDeps: Task[] | undefined = anyInternal.__pipelineDeps
    if (pipelineDeps) {
      for (const dep of pipelineDeps) {
        if (dep !== task) {
          deps.add(dep)
        }
      }
    }

    // Check for command-level dependencies (only Tasks now)
    const commands = internal.commands as import("../types.js").Commands
    const cmdConfig = commands[command]
    if (cmdConfig && typeof cmdConfig !== "string") {
      // Get dependencies directly from the command config
      // These are stored as Task objects
      const commandDeps = cmdConfig.dependencies || []
      for (const dep of commandDeps) {
        // It's a Task - add it directly
        const taskDep = dep as Task
        if (taskDep !== task) {
          deps.add(taskDep)
        }
      }

      // Check for artifacts in cache config - these also create execution dependencies
      // Artifacts are inputs, but we still need to ensure the producing task completes first
      const cacheConfig = cmdConfig.cache as InternalCacheConfig | undefined
      if (cacheConfig && cacheConfig.artifacts) {
        for (const artifact of cacheConfig.artifacts) {
          if (artifact.task !== task) {
            deps.add(artifact.task)
          }
        }
      }
    }

    return Array.from(deps)
  }

  // Recursively collect all tasks reachable from root tasks
  const collectTasks = (task: Task): void => {
    if (allTasks.has(task)) {
      return // Already collected
    }

    // Skip tasks that should be excluded (e.g., already-satisfied dependencies)
    if (excludeTasks && excludeTasks.has(task)) {
      return
    }

    allTasks.add(task)

    // Get dependencies and recursively collect them
    const deps = getTaskDependencies(task)
    for (const dep of deps) {
      collectTasks(dep)
    }
  }

  // Start from root tasks and collect all transitive dependencies
  for (const rootTask of rootTasks) {
    collectTasks(rootTask)
  }

  // Create nodes for all collected tasks
  for (const task of allTasks) {
    const { id: taskId } = task[$TASK_INTERNAL]
    nodes.set(taskId, {
      task,
      dependencies: new Set(),
      dependents: new Set(),
    })
  }

  // Build dependency relationships
  for (const task of allTasks) {
    const { id: taskId } = task[$TASK_INTERNAL]
    const node = nodes.get(taskId)!

    const deps = getTaskDependencies(task)

    for (const dep of deps) {
      const { id: depId } = dep[$TASK_INTERNAL]
      // All dependencies should already be in the graph (collected recursively)
      if (!nodes.has(depId)) {
        // This shouldn't happen, but handle gracefully
        continue
      }
      node.dependencies.add(depId)
      nodes.get(depId)!.dependents.add(taskId)
    }
  }

  return {
    nodes,
    validate() {
      // Use DFS to detect cycles
      const visited = new Set<string>()
      const recursionStack = new Set<string>()

      const visit = (nodeId: string, path: string[]): void => {
        if (recursionStack.has(nodeId)) {
          // Found a cycle - build the cycle path
          const cycleStart = path.indexOf(nodeId)
          const cycle = [...path.slice(cycleStart), nodeId]
          throw new PipelineError(
            `Circular dependency detected: ${cycle.join(" -> ")}`,
            PipelineError.InvalidGraph
          )
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
      const reachable = new Map<string, Set<string>>()

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
        const toRemove = new Set<string>()
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
