import type { TaskGraph } from "../types.js"
import type { TaskExecution } from "./execution-context.js"

/**
 * Queue manager interface returned by createQueueManager
 */
export interface QueueManager {
  getNextReadyTask(): string | null
  markRunningTaskReady(taskId: string): void
  markTaskComplete(taskId: string): void
  markTaskFailed(taskId: string): void
  markTaskSkipped(taskId: string): void
  markTaskRunning(taskId: string, execution: TaskExecution): void
  canExecuteMore(): boolean
  isComplete(): boolean
  hasFailed(): boolean
  getRunningTasks(): Map<string, TaskExecution>
  clearQueues(): void
  abortAllRunningTasks(): void
}

/**
 * Creates a queue manager that replaces the generator-based scheduler
 * with explicit queue-based execution state management
 */
export function createQueueManager(
  graph: TaskGraph,
  maxConcurrency?: number
): QueueManager {
  const readyQueue: string[] = []
  const waitingQueue: Map<string, number> = new Map()
  const runningTasks: Map<string, TaskExecution> = new Map()
  const completedTasks: Set<string> = new Set()
  const failedTasks: Set<string> = new Set()
  const skippedTasks: Set<string> = new Set()
  const maxConcurrencyLimit: number = maxConcurrency ?? Infinity
  let status: "running" | "completed" | "failed" | "aborted" = "running"

  for (const [taskId, node] of graph.nodes) {
    const depCount = node.dependencies.size
    if (depCount === 0) {
      readyQueue.push(taskId)
    } else {
      waitingQueue.set(taskId, depCount)
    }
  }

  const updateDependentTasks = (completedTaskId: string): void => {
    const node = graph.nodes.get(completedTaskId)
    if (!node) return

    for (const dependentId of node.dependents) {
      const currentCount = waitingQueue.get(dependentId)
      if (currentCount === undefined) continue

      const newCount = currentCount - 1
      if (newCount > 0) {
        waitingQueue.set(dependentId, newCount)
        continue
      }

      waitingQueue.delete(dependentId)
      readyQueue.push(dependentId)
    }
  }

  const allTasksFinished = (): boolean => {
    const totalTasks = graph.nodes.size
    const finishedTasks =
      completedTasks.size + failedTasks.size + skippedTasks.size
    return finishedTasks === totalTasks
  }

  /**
   * Update execution status based on current queue state
   */
  const updateExecutionStatus = (): void => {
    if (status === "failed" || status === "aborted") {
      return // Don't change from terminal states
    }

    if (allTasksFinished()) {
      status = "completed"
    }
  }

  return {
    /**
     * Get the next ready task for execution, respecting concurrency limits
     * Returns null if pipeline has failed or been aborted
     */
    getNextReadyTask(): string | null {
      // Don't return tasks if pipeline has failed or been aborted
      if (status === "failed" || status === "aborted") {
        return null
      }
      if (readyQueue.length === 0) return null
      if (runningTasks.size >= maxConcurrencyLimit) return null
      // Additional check: if we have failed tasks, don't process new ones
      if (failedTasks.size > 0) {
        return null
      }

      const taskId = readyQueue.shift() ?? null
      if (taskId) {
        // Final check before returning - prevent race conditions
        // Check failed tasks to prevent race conditions (status check already done above)
        if (failedTasks.size > 0) {
          // Put it back if we detected failure
          readyQueue.unshift(taskId)
          return null
        }
      }
      return taskId
    },

    /**
     * Mark a running task as ready (via readyWhen) and update dependent tasks
     */
    markRunningTaskReady(taskId: string): void {
      if (runningTasks.has(taskId)) {
        updateDependentTasks(taskId)
      }
    },

    /**
     * Mark a task as complete and update dependent tasks
     */
    markTaskComplete(taskId: string): void {
      runningTasks.delete(taskId)
      completedTasks.add(taskId)
      updateDependentTasks(taskId)
      updateExecutionStatus()
    },

    /**
     * Mark a task as failed
     * When a task fails, we clear the ready queue immediately to prevent dependent tasks from starting.
     * Note: This clears only the ready queue. The full cleanup (including waiting queue) happens
     * in failPipeline via clearQueues(). This immediate ready queue clearing is critical to prevent
     * race conditions where dependent tasks might be in the ready queue when a dependency fails.
     * Failed tasks don't update dependents as they block the pipeline.
     */
    markTaskFailed(taskId: string): void {
      runningTasks.delete(taskId)
      failedTasks.add(taskId)
      status = "failed"
      // Clear ready queue immediately to prevent any dependent tasks from starting
      // This is critical to prevent race conditions where dependent tasks might
      // be in the ready queue when a dependency fails
      readyQueue.length = 0
    },

    /**
     * Mark a task as skipped and update dependent tasks
     */
    markTaskSkipped(taskId: string): void {
      runningTasks.delete(taskId)
      skippedTasks.add(taskId)
      updateDependentTasks(taskId)
      updateExecutionStatus()
    },

    /**
     * Mark a task as running
     */
    markTaskRunning(taskId: string, execution: TaskExecution): void {
      runningTasks.set(taskId, execution)
    },

    /**
     * Check if there are more tasks that can be executed
     */
    canExecuteMore(): boolean {
      return readyQueue.length > 0 && runningTasks.size < maxConcurrencyLimit
    },

    /**
     * Check if all tasks are complete (either completed, failed, or skipped)
     */
    isComplete: allTasksFinished,

    /**
     * Check if any tasks have failed
     */
    hasFailed(): boolean {
      return failedTasks.size > 0
    },

    /**
     * Get current running tasks
     */
    getRunningTasks(): Map<string, TaskExecution> {
      return new Map(runningTasks)
    },

    /**
     * Clear all queues (used during cancellation)
     * This prevents any pending tasks from starting, but preserves their status
     * as "pending" in the task stats (they are not marked as aborted)
     */
    clearQueues(): void {
      readyQueue.length = 0
      waitingQueue.clear()
      // Keep running tasks for cleanup, but mark them for termination
      // Note: Tasks in waitingQueue remain with "pending" status - they are not
      // moved to failed/aborted state since they never started
    },

    /**
     * Mark all running tasks as aborted and clear them from running tasks
     * Used during cancellation to ensure proper state consistency
     */
    abortAllRunningTasks(): void {
      // Move all running tasks to failed state
      for (const taskId of runningTasks.keys()) {
        failedTasks.add(taskId)
      }
      runningTasks.clear()
      status = "aborted"
    },
  }
}
