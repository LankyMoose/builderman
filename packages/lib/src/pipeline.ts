import { spawn } from "node:child_process"
import { platform } from "node:os"

import { $TASK_INTERNAL, $PIPELINE_INTERNAL } from "./internal/constants.js"
import { createTaskGraph } from "./internal/graph.js"
import { validateTasks } from "./internal/util.js"
import { createTeardownManager } from "./internal/teardown-manager.js"
import { createSignalHandler } from "./internal/signal-handler.js"
import {
  executeTask,
  type TaskExecutionCallbacks,
} from "./internal/task-executor.js"
import { createQueueManager } from "./internal/queue-manager.js"
import { createTimeoutManager } from "./internal/timeout-manager.js"
import { createExecutionContext } from "./internal/execution-context.js"
import { PipelineError } from "./errors.js"
import { task } from "./task.js"

import type {
  Pipeline,
  Task,
  RunResult,
  PipelineStats,
  TaskStats,
} from "./types.js"

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 * @param tasks - The tasks to include in the pipeline.
 * @returns A pipeline that can be used to execute the tasks.
 * @example
 * const task1 = task({ name: "task1", commands: { dev: "echo task1" }, cwd: "." })
 * const task2 = task({ name: "task2", commands: { dev: "echo task2" }, cwd: ".", dependencies: [task1] })
 * await pipeline([task1, task2]).run()
 */
export function pipeline(tasks: Task[]): Pipeline {
  const tasksClone = [...tasks]
  validateTasks(tasksClone)

  const graph = createTaskGraph(tasksClone)
  graph.validate()
  graph.simplify()

  const pipelineImpl: Pipeline = {
    [$PIPELINE_INTERNAL]: {
      tasks: tasksClone,
      graph,
    },

    toTask({ name, dependencies, env }): Task {
      const syntheticTask = task({
        name,
        commands: {},
        dependencies,
        env,
      })

      // Mark this task as a pipeline task so it can be detected by the executor
      syntheticTask[$TASK_INTERNAL].pipeline = pipelineImpl

      return syntheticTask
    },

    async run(config) {
      const spawnFn = config?.spawn ?? spawn
      const signal = config?.signal
      let failed = false

      const command =
        config?.command ??
        (process.env.NODE_ENV === "production" ? "build" : "dev")
      const startedAt = Date.now()

      // Initialize task stats tracking
      const taskStats = new Map<string, TaskStats>()
      for (const [taskId, node] of graph.nodes) {
        const task = node.task
        taskStats.set(taskId, {
          id: taskId,
          name: task.name,
          status: "pending",
          dependencies: Array.from(node.dependencies),
          dependents: Array.from(node.dependents),
        })
      }

      // Check if signal is already aborted
      if (signal?.aborted) {
        const error = new PipelineError("Aborted", PipelineError.Aborted)
        return buildResult(error, startedAt, command, taskStats, "aborted")
      }

      // Helper to update task status
      const updateTaskStatus = (
        taskId: string,
        updates: Partial<TaskStats>
      ) => {
        const stats = taskStats.get(taskId)!
        Object.assign(stats, updates)
      }

      // Initialize queue manager
      const queueManager = createQueueManager(graph, config?.maxConcurrency)

      let completionResolver: ((error: PipelineError | null) => void) | null =
        null
      const completionPromise = new Promise<PipelineError | null>((resolve) => {
        completionResolver = resolve
      })

      // Initialize teardown manager with stats tracking
      const teardownManager = createTeardownManager({
        ...config,
        spawn: spawnFn,
        updateTaskTeardownStatus: (taskId, status, error) => {
          const stats = taskStats.get(taskId)!
          if (stats) {
            stats.teardown = { status, error }
          }
        },
      })

      // Initialize timeout manager
      const timeoutManager = createTimeoutManager()

      // Create execution context
      const executionContext = createExecutionContext(
        config ?? {},
        teardownManager,
        timeoutManager,
        queueManager,
        taskStats
      )

      const failPipeline = async (error: PipelineError) => {
        // Prevent multiple calls to failPipeline
        if (failed) {
          // If we're already failing, just resolve with the error to prevent hanging
          completionResolver?.(error)
          return
        }
        failed = true

        // Clear all timeouts
        timeoutManager.clearAllTimeouts()

        // Get running tasks before clearing queues (so we can kill them)
        const runningTasksSnapshot = queueManager.getRunningTasks()

        // Clear queues immediately to prevent any new tasks from starting
        // This must happen before we process running tasks to prevent race conditions
        queueManager.clearQueues()

        // Mark running tasks as aborted (unless they're already marked as failed)
        // Only tasks that actually started should be marked as aborted
        // Pending tasks (in waitingQueue) remain with "pending" status
        for (const [taskId, execution] of runningTasksSnapshot) {
          const stats = taskStats.get(taskId)!
          // Don't overwrite "failed" status - tasks that failed for specific reasons
          // (like readyTimeout) should remain "failed", not "aborted"
          if (stats.status !== "failed") {
            const finishedAt = Date.now()
            updateTaskStatus(taskId, {
              status: "aborted",
              finishedAt,
            })
            if (stats.startedAt) {
              stats.durationMs = finishedAt - stats.startedAt
            }
          }
          safeKillProcess(execution.process)
        }

        // Abort all running tasks in queue manager (only tasks that actually started)
        queueManager.abortAllRunningTasks()

        // Execute all teardown commands and wait for them to complete
        // Even if teardowns fail, we still want to reject the pipeline
        try {
          await teardownManager.executeAll(graph)
        } catch (teardownError) {
          // Teardown errors are already reported via onTaskTeardownError
          // We continue to reject the pipeline with the original error
        }

        completionResolver?.(error)
      }

      // Task execution callbacks for queue-based coordination
      const taskCallbacks: TaskExecutionCallbacks = {
        onTaskReady(taskId) {
          // Task is ready (via readyWhen) - update dependent tasks immediately
          // Only process ready tasks if pipeline hasn't failed
          if (!isPipelineFailed()) {
            const taskName = taskStats.get(taskId)?.name
            if (taskName) {
              config?.onTaskReady?.(taskName, taskId)
            }
            queueManager.markRunningTaskReady(taskId)
            // Process newly ready tasks immediately
            processReadyTasks()
          }
        },
        onTaskComplete(taskId) {
          queueManager.markTaskComplete(taskId)
          // Process newly ready tasks
          processReadyTasks()
        },
        onTaskFailed(taskId, error) {
          // Set failed flag immediately to prevent race conditions
          // This prevents processReadyTasks from starting new tasks
          failed = true
          queueManager.markTaskFailed(taskId)
          failPipeline(error as PipelineError)
        },
        onTaskSkipped(taskId) {
          queueManager.markTaskSkipped(taskId)
          // Process newly ready tasks
          processReadyTasks()
        },
      }

      // Helper to check if pipeline has failed (checks both local flag and queue manager)
      const isPipelineFailed = (): boolean => {
        return failed || queueManager.hasFailed()
      }

      // Helper to safely kill a process (ignores errors if process is already dead)
      // On Windows with shell:true, we need to kill the entire process tree
      const safeKillProcess = (
        process?: import("node:child_process").ChildProcess
      ): void => {
        if (!process || !process.pid) return

        try {
          // On Windows, when using shell:true, we need to kill the process tree
          // because the shell spawns child processes that won't be killed by just killing the shell
          if (platform() === "win32") {
            // Use taskkill to kill the process tree
            // On Windows with shell:true, the shell spawns child processes that won't be killed
            // by just killing the shell, so we need to kill the entire process tree
            const taskkill = spawn("taskkill", [
              "/PID",
              process.pid.toString(),
              "/T", // Kill child processes
              "/F", // Force kill
            ])
            // Don't wait for taskkill to complete, just fire and forget
            taskkill.on("error", () => {
              // If taskkill fails (e.g., process already dead), fall back to regular kill
              try {
                process.kill("SIGTERM")
              } catch {
                // Ignore
              }
            })
            // Suppress stdout/stderr from taskkill
            taskkill.stdout?.on("data", () => {})
            taskkill.stderr?.on("data", () => {})
          } else {
            // On Unix-like systems, when using shell:true, we need to kill the process tree
            // because the shell spawns child processes that might not be killed by just killing the shell
            // Use pkill to kill the process tree (similar to taskkill on Windows)
            const pkill = spawn("pkill", [
              "-P", // Kill all child processes of this PID
              process.pid.toString(),
              "-TERM", // Send SIGTERM first (graceful)
            ])
            // Also kill the parent process itself
            try {
              process.kill("SIGTERM")
            } catch {
              // Parent might already be dead, ignore
            }
            // If pkill fails (e.g., not available or process already dead), fall back to regular kill
            pkill.on("error", () => {
              // Fall back to regular kill if pkill is not available
              try {
                process.kill("SIGTERM")
              } catch {
                // If SIGTERM fails, try SIGKILL
                try {
                  process.kill("SIGKILL")
                } catch {
                  // Process might already be dead, ignore
                }
              }
            })
            // Suppress stdout/stderr from pkill
            pkill.stdout?.on("data", () => {})
            pkill.stderr?.on("data", () => {})
          }
        } catch {
          // Process might already be dead, ignore
        }
      }

      const startTask = (taskId: string) => {
        // Don't start new tasks if pipeline has already failed
        if (isPipelineFailed()) {
          return
        }

        const node = graph.nodes.get(taskId)
        if (!node) return

        const task = node.task
        const execution = {
          taskId,
          taskName: task.name,
          startedAt: Date.now(),
        }

        // Final check before marking as running - prevent race conditions
        if (isPipelineFailed()) {
          return
        }

        queueManager.markTaskRunning(taskId, execution)
        executeTask(task, executionContext, taskCallbacks)
      }

      const processReadyTasks = () => {
        // Don't process new tasks if pipeline has already failed
        if (isPipelineFailed()) return

        // Check if signal is aborted before processing
        if (signal?.aborted) {
          failPipeline(new PipelineError("Aborted", PipelineError.Aborted))
          return
        }

        // Process all ready tasks up to concurrency limit
        while (queueManager.canExecuteMore() && !isPipelineFailed()) {
          const nextTaskId = queueManager.getNextReadyTask()
          if (!nextTaskId) break

          // Double-check failed status before starting each task
          if (isPipelineFailed()) break

          startTask(nextTaskId)
        }

        // Check if execution is complete
        if (queueManager.isComplete()) {
          if (queueManager.hasFailed()) {
            // Pipeline failed - error should have been handled by onTaskFailed
            return
          } else {
            // Pipeline completed successfully
            completionResolver?.(null)
          }
        }
      }

      // Initialize signal handler
      const signalHandler = createSignalHandler({
        abortSignal: signal,
        onAborted: () =>
          failPipeline(new PipelineError("Aborted", PipelineError.Aborted)),
        onProcessTerminated: (message) =>
          failPipeline(
            new PipelineError(message, PipelineError.ProcessTerminated)
          ),
      })

      // 🚀 Start processing ready tasks
      processReadyTasks()

      const error = await completionPromise.then(async (err) => {
        // Pipeline completed - execute any remaining teardowns
        // (for tasks that completed successfully) and wait for them to complete
        // Even if teardowns fail, the pipeline still resolves successfully
        // (teardown errors are reported via onTaskTeardownError)
        try {
          await teardownManager.executeAll(graph)
        } catch (teardownError) {
          // Teardown errors are already reported via onTaskTeardownError
          // The pipeline still resolves successfully
        }
        return err
      })

      signalHandler.cleanup()

      const status: "success" | "failed" | "aborted" = error
        ? error.code === PipelineError.Aborted
          ? "aborted"
          : "failed"
        : "success"

      return buildResult(error, startedAt, command, taskStats, status)
    },
  }

  return pipelineImpl
}

function buildResult(
  error: PipelineError | null,
  startedAt: number,
  command: string,
  taskStats: Map<string, TaskStats>,
  status: "success" | "failed" | "aborted"
): RunResult {
  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt

  // Convert task stats map to record
  const tasks: Record<string, TaskStats> = {}
  for (const [taskId, stats] of taskStats) {
    tasks[taskId] = stats
  }

  // Calculate summary
  let completed = 0
  let failed = 0
  let skipped = 0
  let running = 0

  for (const stats of taskStats.values()) {
    switch (stats.status) {
      case "completed":
        completed++
        break
      case "failed":
        failed++
        break
      case "skipped":
        skipped++
        break
      case "running":
        running++
        break
    }
  }

  const pipelineStats: PipelineStats = {
    command,
    startedAt,
    finishedAt,
    durationMs,
    status,
    tasks,
    summary: {
      total: taskStats.size,
      completed,
      failed,
      skipped,
      running,
    },
  }

  if (error) {
    return { ok: false, error, stats: pipelineStats }
  } else {
    return { ok: true, error: null, stats: pipelineStats }
  }
}
