import { spawn } from "node:child_process"

import { PipelineError } from "../errors.js"
import type {
  PipelineRunConfig,
  RunResult,
  Task,
  TaskGraph,
  TaskStats,
} from "../types.js"
import { createTaskGraph } from "./graph.js"
import { createTeardownManager } from "./teardown-manager.js"
import { createSignalHandler } from "./signal-handler.js"
import {
  executeTask,
  type TaskExecutionCallbacks,
} from "./task-executor.js"
import { createQueueManager } from "./queue-manager.js"
import { createTimeoutManager } from "./timeout-manager.js"
import { createExecutionContext } from "./execution-context.js"
import type { SignalHandler } from "./signal-handler.js"
import type { TeardownManager } from "./teardown-manager.js"
import type { TimeoutManager } from "./timeout-manager.js"
import type { QueueManager } from "./queue-manager.js"
import type { ExecutionContext } from "./execution-context.js"

/**
 * Context that holds all state for a pipeline execution run.
 * This includes state for the pipeline itself and all nested pipelines/tasks.
 */
export interface RunContext {
  // Configuration
  config: PipelineRunConfig
  command: string
  spawnFn: typeof import("node:child_process").spawn
  signal?: AbortSignal

  // Execution state
  startedAt: number
  failed: boolean

  // Graph and task tracking
  graph: TaskGraph
  taskStats: Map<string, TaskStats>

  // Managers
  queueManager: QueueManager
  teardownManager: TeardownManager
  timeoutManager: TimeoutManager
  signalHandler: SignalHandler | null // Set up in runPipeline
  executionContext: ExecutionContext

  // Completion handling
  completionResolver: ((error: PipelineError | null) => void) | null
  completionPromise: Promise<PipelineError | null>
}

/**
 * Builds the result object from the run context.
 */
function buildResult(
  error: PipelineError | null,
  startedAt: number,
  command: string,
  taskStats: Map<string, TaskStats>,
  status: "success" | "failed" | "aborted"
): RunResult {
  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt

  // Convert task stats map to array
  const tasks: TaskStats[] = Array.from(taskStats.values())

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

  const pipelineStats = {
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

/**
 * Creates a RunContext for a pipeline execution.
 */
export function createRunContext(
  tasks: Task[],
  config: PipelineRunConfig | undefined
): RunContext {
  const spawnFn = config?.spawn ?? spawn
  const signal = config?.signal

  const command =
    config?.command ??
    (process.env.NODE_ENV === "production" ? "build" : "dev")
  const startedAt = Date.now()

  // Build a graph for this run based on command-level dependencies
  // The graph will include all transitive dependencies, not just tasks in the pipeline
  // Exclude tasks that are already satisfied (e.g., by outer pipeline)
  const graph = createTaskGraph(tasks, command, config?.excludeTasks)

  graph.validate()
  graph.simplify()

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

  return {
    config: config ?? {},
    command,
    spawnFn,
    signal,
    startedAt,
    failed: false,
    graph,
    taskStats,
    queueManager,
    teardownManager,
    timeoutManager,
    signalHandler: null as any, // Will be set up in runPipeline
    executionContext,
    completionResolver,
    completionPromise,
  }
}

/**
 * Runs a pipeline with the given context.
 * This is the core execution logic extracted from Pipeline.run().
 */
export async function runPipeline(
  context: RunContext
): Promise<RunResult> {
  const {
    config,
    command,
    signal,
    startedAt,
    graph,
    taskStats,
    queueManager,
    teardownManager,
    timeoutManager,
    executionContext,
    completionPromise,
  } = context

  // Helper to update task status
  const updateTaskStatus = (
    taskId: string,
    updates: Partial<TaskStats>
  ) => {
    const stats = taskStats.get(taskId)!
    Object.assign(stats, updates)
  }

  // Check if signal is already aborted
  if (signal?.aborted) {
    const error = new PipelineError("Aborted", PipelineError.Aborted)
    return buildResult(error, startedAt, command, taskStats, "aborted")
  }

  const failPipeline = async (error: PipelineError) => {
    // Prevent multiple calls to failPipeline
    if (context.failed) {
      // If we're already failing, just resolve with the error to prevent hanging
      context.completionResolver?.(error)
      return
    }
    context.failed = true

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

    context.completionResolver?.(error)
  }

  // Helper to check if pipeline has failed (checks both local flag and queue manager)
  const isPipelineFailed = (): boolean => {
    return context.failed || queueManager.hasFailed()
  }

  // Helper to safely kill a process (ignores errors if process is already dead).
  // With shell:false and direct child processes, a single SIGTERM is usually enough;
  // we avoid force-killing from the outside so the child has a chance to run its
  // own signal handlers and exit cleanly.
  const safeKillProcess = (
    process?: import("node:child_process").ChildProcess
  ): void => {
    if (!process) return

    try {
      // Try a graceful SIGTERM and let the child handle it.
      process.kill("SIGTERM")
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
        context.completionResolver?.(null)
      }
    }
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
      context.failed = true
      queueManager.markTaskFailed(taskId)
      failPipeline(error as PipelineError)
    },
    onTaskSkipped(taskId) {
      queueManager.markTaskSkipped(taskId)
      // Process newly ready tasks
      processReadyTasks()
    },
  }

  // Initialize signal handler (after we have failPipeline)
  const signalHandler = createSignalHandler({
    abortSignal: signal,
    onAborted: () =>
      failPipeline(new PipelineError("Aborted", PipelineError.Aborted)),
    onProcessTerminated: (message) =>
      failPipeline(
        new PipelineError(message, PipelineError.ProcessTerminated)
      ),
  })
  context.signalHandler = signalHandler

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
}
