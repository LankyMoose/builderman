import { type ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL } from "../constants.js"
import { createTaskGraph } from "../graph.js"
import { PipelineError } from "../pipeline-error.js"

import type {
  Task,
  Pipeline,
  PipelineRunConfig,
  TaskGraph,
  TaskStats,
} from "../types.js"
import type { SchedulerInput } from "../scheduler.js"
import type { TeardownManager } from "./teardown-manager.js"

export interface TaskExecutorConfig {
  spawn: typeof import("node:child_process").spawn
  signal?: AbortSignal
  config?: PipelineRunConfig
  graph: TaskGraph
  runningTasks: Map<string, ChildProcess>
  runningPipelines: Map<string, { stop: () => void }>
  teardownManager: TeardownManager
  pipelineTasksCache: WeakMap<Pipeline, Task[]>
  failPipeline: (error: PipelineError) => Promise<void>
  advanceScheduler: (input?: SchedulerInput) => void
  updateTaskStatus: (taskId: string, updates: Partial<TaskStats>) => void
  taskStats: Map<string, TaskStats>
}

/**
 * Executes a task (either a regular task or a nested pipeline).
 */
export function executeTask(
  task: Task,
  executorConfig: TaskExecutorConfig
): void {
  // Check if signal is aborted before starting new tasks
  if (executorConfig.signal?.aborted) {
    executorConfig.failPipeline(
      new PipelineError("Aborted", PipelineError.InvalidSignal)
    )
    return
  }

  const {
    name: taskName,
    [$TASK_INTERNAL]: { id: taskId, pipeline: nestedPipeline },
  } = task

  if (executorConfig.runningTasks.has(taskId)) return

  // Handle pipeline tasks
  if (nestedPipeline) {
    executeNestedPipeline(taskId, taskName, nestedPipeline, executorConfig)
    return
  }

  // Regular task execution
  executeRegularTask(task, taskId, taskName, executorConfig)
}

function executeNestedPipeline(
  taskId: string,
  taskName: string,
  nestedPipeline: Pipeline,
  executorConfig: TaskExecutorConfig
): void {
  const {
    config,
    runningPipelines,
    pipelineTasksCache,
    failPipeline,
    advanceScheduler,
    updateTaskStatus,
  } = executorConfig

  // Track nested pipeline state for skip behavior
  let nestedSkippedCount = 0
  let nestedCompletedCount = 0

  // Get total tasks from nested pipeline
  const nestedTasks = pipelineTasksCache.get(nestedPipeline)
  const nestedTotalTasks = nestedTasks
    ? createTaskGraph(nestedTasks).nodes.size
    : 0

  const commandName =
    (config?.command ?? process.env.NODE_ENV === "production") ? "build" : "dev"

  // Mark as ready immediately (pipeline entry nodes will handle their own ready state)
  const startedAt = Date.now()
  updateTaskStatus(taskId, {
    status: "running",
    command: commandName,
    startedAt,
  })
  advanceScheduler({ type: "ready", taskId })
  config?.onTaskBegin?.(taskName)

  // Create an abort controller to stop the nested pipeline if needed
  let pipelineStopped = false
  const stopPipeline = () => {
    pipelineStopped = true
    // The nested pipeline will continue running, but we've marked it as stopped
    // In a more sophisticated implementation, we could propagate stop signals
  }

  runningPipelines.set(taskId, { stop: stopPipeline })

  // Run the nested pipeline with signal propagation
  nestedPipeline
    .run({
      spawn: executorConfig.spawn,
      command: config?.command,
      strict: config?.strict,
      signal: executorConfig.signal, // Pass signal to nested pipeline
      onTaskBegin: (nestedTaskName) => {
        if (pipelineStopped) return
        config?.onTaskBegin?.(`${taskName}:${nestedTaskName}`)
      },
      onTaskComplete: (nestedTaskName) => {
        if (pipelineStopped) return
        nestedCompletedCount++
        config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`)
      },
      onTaskSkipped: (nestedTaskName, mode) => {
        if (pipelineStopped) return
        nestedSkippedCount++
        config?.onTaskSkipped?.(`${taskName}:${nestedTaskName}`, mode)
      },
    })
    .then((result) => {
      if (pipelineStopped) return
      runningPipelines.delete(taskId)

      if (!result.ok) {
        // Nested pipeline failed
        const finishedAt = Date.now()
        updateTaskStatus(taskId, {
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: result.error,
        })
        failPipeline(result.error)
        return
      }

      // Determine nested pipeline result based on skip behavior:
      // - If all inner tasks are skipped → outer task is skipped
      // - If some run, some skip → outer task is completed
      // - If any fail → outer task fails (handled above)
      if (nestedSkippedCount === nestedTotalTasks && nestedTotalTasks > 0) {
        // All tasks were skipped
        const finishedAt = Date.now()
        updateTaskStatus(taskId, {
          status: "skipped",
          finishedAt,
          durationMs: finishedAt - startedAt,
        })
        config?.onTaskSkipped?.(taskName, commandName)
        setImmediate(() => {
          advanceScheduler({ type: "skip", taskId })
        })
      } else {
        // Some tasks ran (and completed successfully)
        const finishedAt = Date.now()
        updateTaskStatus(taskId, {
          status: "completed",
          finishedAt,
          durationMs: finishedAt - startedAt,
        })
        config?.onTaskComplete?.(taskName)
        advanceScheduler({ type: "complete", taskId })
      }
    })
}

function executeRegularTask(
  task: Task,
  taskId: string,
  taskName: string,
  executorConfig: TaskExecutorConfig
): void {
  const {
    spawn: spawnFn,
    signal,
    config,
    runningTasks,
    teardownManager,
    failPipeline,
    advanceScheduler,
    updateTaskStatus,
  } = executorConfig

  const commandName =
    (config?.command ?? process.env.NODE_ENV === "production") ? "build" : "dev"
  const commandConfig = task[$TASK_INTERNAL].commands[commandName]

  // Check if command exists
  if (commandConfig === undefined) {
    const allowSkip = task[$TASK_INTERNAL].allowSkip ?? false
    const strict = config?.strict ?? false

    // If strict mode and not explicitly allowed to skip, fail
    if (strict && !allowSkip) {
      const error = new PipelineError(
        `[${taskName}] No command for "${commandName}" and strict mode is enabled`,
        PipelineError.TaskFailed,
        taskName
      )
      const finishedAt = Date.now()
      updateTaskStatus(taskId, {
        status: "failed",
        command: commandName,
        finishedAt,
        error,
      })
      failPipeline(error)
      return
    }

    // Skip the task
    const finishedAt = Date.now()
    updateTaskStatus(taskId, {
      status: "skipped",
      command: commandName,
      finishedAt,
      durationMs: 0,
    })
    config?.onTaskSkipped?.(taskName, commandName)
    // Mark as skipped - this satisfies dependencies and unblocks dependents
    // Use setImmediate to ensure scheduler is at idle yield before receiving skip
    setImmediate(() => {
      advanceScheduler({ type: "skip", taskId })
    })
    return
  }

  const command =
    typeof commandConfig === "string" ? commandConfig : commandConfig.run
  const readyWhen =
    typeof commandConfig === "string" ? undefined : commandConfig.readyWhen
  const readyTimeout =
    typeof commandConfig === "string"
      ? Infinity
      : (commandConfig.readyTimeout ?? Infinity)
  const teardown =
    typeof commandConfig === "string" ? undefined : commandConfig.teardown

  const { cwd } = task[$TASK_INTERNAL]

  const taskCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd)

  if (!fs.existsSync(taskCwd)) {
    const finishedAt = Date.now()
    const pipelineError = new PipelineError(
      `[${taskName}] Working directory does not exist: ${taskCwd}`,
      PipelineError.InvalidTask,
      taskName
    )
    updateTaskStatus(taskId, {
      status: "failed",
      command: commandName,
      finishedAt,
      durationMs: 0,
      error: pipelineError,
    })
    failPipeline(pipelineError)
    return
  }

  const accumulatedPath = [
    path.join(taskCwd, "node_modules", ".bin"),
    path.join(process.cwd(), "node_modules", ".bin"),
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(process.platform === "win32" ? ";" : ":")

  const env = {
    ...process.env,
    PATH: accumulatedPath,
    Path: accumulatedPath,
  }

  const child = spawnFn(command, {
    cwd: taskCwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
    env,
  })

  runningTasks.set(taskId, child)

  const startedAt = Date.now()
  updateTaskStatus(taskId, {
    status: "running",
    command: commandName,
    startedAt,
  })

  // Store teardown command if provided
  if (teardown) {
    teardownManager.register(taskId, {
      command: teardown,
      cwd: taskCwd,
      taskName,
    })
  }

  config?.onTaskBegin?.(taskName)

  let didMarkReady = false
  let readyTimeoutId: NodeJS.Timeout | null = null

  if (!readyWhen) {
    advanceScheduler({ type: "ready", taskId })
    didMarkReady = true
  } else if (readyTimeout !== Infinity) {
    // Set up timeout for readyWhen condition
    readyTimeoutId = setTimeout(() => {
      if (!didMarkReady) {
        const finishedAt = Date.now()
        const pipelineError = new PipelineError(
          `[${taskName}] Task did not become ready within ${readyTimeout}ms`,
          PipelineError.TaskFailed,
          taskName
        )
        updateTaskStatus(taskId, {
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: pipelineError,
        })
        failPipeline(pipelineError)
      }
    }, readyTimeout)
  }

  let output = ""

  child.stdout?.on("data", (buf: Buffer) => {
    // Check if signal is aborted before processing stdout
    if (signal?.aborted) {
      return
    }

    const chunk = buf.toString()
    output += chunk
    process.stdout.write(chunk)

    if (!didMarkReady && readyWhen && readyWhen(output)) {
      if (readyTimeoutId) {
        clearTimeout(readyTimeoutId)
        readyTimeoutId = null
      }
      advanceScheduler({ type: "ready", taskId })
      didMarkReady = true
    }
  })

  child.stderr?.on("data", (buf: Buffer) => {
    process.stderr.write(buf)
  })

  child.on("error", (error: Error) => {
    // Task failed before entering running state, so don't execute teardown
    // Remove teardown from map since it was never actually running
    teardownManager.unregister(taskId)

    // Clear ready timeout if it exists
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId)
      readyTimeoutId = null
    }

    const finishedAt = Date.now()
    const pipelineError = new PipelineError(
      `[${taskName}] Failed to start: ${error.message}`,
      PipelineError.TaskFailed,
      taskName
    )
    updateTaskStatus(taskId, {
      status: "failed",
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: pipelineError,
    })
    failPipeline(pipelineError)
  })

  child.on("exit", (code: number | null, signal: string | null) => {
    runningTasks.delete(taskId)

    // Clear ready timeout if it exists
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId)
      readyTimeoutId = null
    }

    const finishedAt = Date.now()
    const durationMs = finishedAt - startedAt

    // Don't execute teardown immediately - it will be executed in reverse dependency order
    // when the pipeline completes or fails

    if (code !== 0 || signal) {
      const pipelineError = new PipelineError(
        `[${taskName}] Task failed with non-zero exit code: ${code ?? signal}`,
        PipelineError.TaskFailed,
        taskName
      )
      updateTaskStatus(taskId, {
        status: "failed",
        finishedAt,
        durationMs,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        error: pipelineError,
      })
      failPipeline(pipelineError)
      return
    }

    updateTaskStatus(taskId, {
      status: "completed",
      finishedAt,
      durationMs,
      exitCode: code ?? 0,
    })
    config?.onTaskComplete?.(taskName)

    // 🔑 Notify scheduler and drain newly runnable tasks
    advanceScheduler({ type: "complete", taskId })
  })
}
