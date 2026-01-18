import type { TaskGraph } from "../types.js"

export interface TeardownCommand {
  command: string
  cwd: string
  taskName: string
}

export interface TeardownManagerConfig {
  spawn: typeof import("node:child_process").spawn
  onTaskTeardown?: (taskName: string) => void
  onTaskTeardownError?: (taskName: string, error: Error) => void
  updateTaskTeardownStatus: (
    taskId: string,
    status: "not-run" | "completed" | "failed",
    error?: Error
  ) => void
}

export interface TeardownManager {
  register(taskId: string, teardown: TeardownCommand): void
  unregister(taskId: string): void
  executeAll(graph: TaskGraph): Promise<void>
}

/**
 * Creates a teardown manager for a pipeline.
 * Manages teardown commands for tasks, handling execution order and error reporting.
 */
export function createTeardownManager(
  config: TeardownManagerConfig
): TeardownManager {
  const teardownCommands = new Map<string, TeardownCommand>()

  /**
   * Executes a single teardown command.
   */
  const executeTeardown = (taskId: string): Promise<void> => {
    const teardown = teardownCommands.get(taskId)
    if (!teardown) {
      // No teardown registered, mark as not-run
      config.updateTaskTeardownStatus(taskId, "not-run")
      return Promise.resolve()
    }

    // Remove from map so it doesn't run again
    teardownCommands.delete(taskId)

    config.onTaskTeardown?.(teardown.taskName)

    return new Promise<void>((resolve) => {
      try {
        const teardownProcess = config.spawn(teardown.command, {
          cwd: teardown.cwd,
          stdio: "inherit",
          shell: true,
        })

        let resolved = false
        const resolveOnce = () => {
          if (!resolved) {
            resolved = true
            resolve()
          }
        }

        teardownProcess.on("error", (error) => {
          const teardownError = new Error(
            `[${teardown.taskName}] Teardown failed: ${error.message}`
          )
          config.onTaskTeardownError?.(teardown.taskName, teardownError)
          config.updateTaskTeardownStatus(taskId, "failed", teardownError)
          resolveOnce()
        })

        teardownProcess.on("exit", (code) => {
          if (code !== 0) {
            const teardownError = new Error(
              `[${teardown.taskName}] Teardown failed with exit code ${
                code ?? 1
              }`
            )
            config.onTaskTeardownError?.(teardown.taskName, teardownError)
            config.updateTaskTeardownStatus(taskId, "failed", teardownError)
          } else {
            config.updateTaskTeardownStatus(taskId, "completed")
          }
          resolveOnce()
        })
      } catch (error: any) {
        const teardownError = new Error(
          `[${teardown.taskName}] Teardown failed to start: ${error.message}`
        )
        config.onTaskTeardownError?.(teardown.taskName, teardownError)
        config.updateTaskTeardownStatus(taskId, "failed", teardownError)
        resolve()
      }
    })
  }

  return {
    /**
     * Registers a teardown command for a task.
     */
    register(taskId: string, teardown: TeardownCommand): void {
      teardownCommands.set(taskId, teardown)
    },

    /**
     * Removes a teardown command (e.g., if task failed before starting).
     */
    unregister(taskId: string): void {
      teardownCommands.delete(taskId)
    },

    /**
     * Executes all registered teardowns in reverse dependency order.
     * Tasks with dependents are torn down before their dependencies.
     */
    async executeAll(graph: TaskGraph): Promise<void> {
      const taskIdsWithTeardown = Array.from(teardownCommands.keys())

      if (taskIdsWithTeardown.length === 0) {
        return
      }

      // Calculate reverse topological order
      const teardownOrder = getReverseDependencyOrder(
        taskIdsWithTeardown,
        graph
      )

      // Execute teardowns sequentially in reverse dependency order
      for (const taskId of teardownOrder) {
        await executeTeardown(taskId)
      }

      // Mark any remaining tasks (that had teardown registered but weren't in the order) as not-run
      for (const taskId of teardownCommands.keys()) {
        config.updateTaskTeardownStatus(taskId, "not-run")
      }
    },
  }
}

/**
 * Calculates the reverse dependency order for teardown execution.
 * Tasks that have dependents should be torn down first.
 * If api depends on db, we want: api first, then db.
 */
function getReverseDependencyOrder(
  taskIds: string[],
  graph: TaskGraph
): string[] {
  const taskIdSet = new Set(taskIds)

  // Count how many dependencies each task has (within the teardown set)
  const dependencyCount = new Map<string, number>()
  for (const taskId of taskIds) {
    const node = graph.nodes.get(taskId)
    if (node) {
      let count = 0
      for (const depId of node.dependencies) {
        if (taskIdSet.has(depId)) {
          count++
        }
      }
      dependencyCount.set(taskId, count)
    }
  }

  // Build result in reverse order
  const result: string[] = []
  const visited = new Set<string>()
  const queue: string[] = []

  // Find leaf nodes (tasks with no dependencies in teardown set)
  for (const taskId of taskIds) {
    if (dependencyCount.get(taskId) === 0) {
      queue.push(taskId)
    }
  }

  // Process in reverse topological order
  while (queue.length > 0) {
    const taskId = queue.shift()!
    if (visited.has(taskId)) continue
    visited.add(taskId)

    // Add to front (so we get reverse order: dependents before dependencies)
    result.unshift(taskId)

    // Find tasks that depend on this one (dependents)
    const node = graph.nodes.get(taskId)
    if (node) {
      for (const dependentId of node.dependents) {
        if (taskIdSet.has(dependentId) && !visited.has(dependentId)) {
          const currentCount = dependencyCount.get(dependentId) ?? 0
          const newCount = currentCount - 1
          dependencyCount.set(dependentId, newCount)
          // When a dependent has no more dependencies to wait for, add it to queue
          if (newCount === 0) {
            queue.push(dependentId)
          }
        }
      }
    }
  }

  // Add any remaining tasks (shouldn't happen in a valid graph, but handle it)
  for (const taskId of taskIds) {
    if (!visited.has(taskId)) {
      result.unshift(taskId)
    }
  }

  return result
}
