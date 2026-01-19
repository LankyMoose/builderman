import { spawn } from "node:child_process"

import type { PipelineRunConfig, TaskStats } from "../types.js"
import type { TeardownManager } from "./teardown-manager.js"
import type { TimeoutManager } from "./timeout-manager.js"
import type { QueueManager } from "./queue-manager.js"

/**
 * Represents a task execution in progress
 */
export interface TaskExecution {
  taskId: string
  taskName: string
  process?: import("node:child_process").ChildProcess
  startedAt: number
  readyAt?: number // When task became ready (for readyWhen tasks)
}

/**
 * Centralized execution context that replaces scattered configuration parameters
 * and provides unified access to execution state and helper methods
 */
export interface ExecutionContext {
  config: PipelineRunConfig
  signal?: AbortSignal
  spawn: typeof import("node:child_process").spawn
  teardownManager: TeardownManager
  timeoutManager: TimeoutManager
  queueManager: QueueManager
  taskStats: Map<string, TaskStats>

  // State management helpers
  updateTaskStatus: (taskId: string, updates: Partial<TaskStats>) => void
  isAborted: () => boolean
}

/**
 * Creates an execution context for pipeline execution
 */
export function createExecutionContext(
  config: PipelineRunConfig,
  teardownManager: TeardownManager,
  timeoutManager: TimeoutManager,
  queueManager: QueueManager,
  taskStats: Map<string, TaskStats>
): ExecutionContext {
  // Use dynamic import only if spawn is not provided
  const spawnFn = config.spawn ?? spawn

  return {
    config,
    signal: config.signal,
    spawn: spawnFn,
    teardownManager,
    timeoutManager,
    queueManager,
    taskStats,

    updateTaskStatus(taskId: string, updates: Partial<TaskStats>): void {
      const currentStats = taskStats.get(taskId)!
      const updatedStats = { ...currentStats, ...updates }

      // Calculate duration if both start and finish times are available
      if (updatedStats.startedAt && updatedStats.finishedAt) {
        updatedStats.durationMs =
          updatedStats.finishedAt - updatedStats.startedAt
      }

      taskStats.set(taskId, updatedStats)
    },

    isAborted(): boolean {
      return config.signal?.aborted ?? false
    },
  }
}
