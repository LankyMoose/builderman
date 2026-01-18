import { type ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL, $PIPELINE_INTERNAL } from "../constants.js"
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
      new PipelineError("Aborted", PipelineError.Aborted)
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
    executeNestedPipeline(
      task,
      taskId,
      taskName,
      nestedPipeline,
      executorConfig
    )
    return
  }

  // Regular task execution
  executeRegularTask(task, taskId, taskName, executorConfig)
}

function executeNestedPipeline(
  task: Task,
  taskId: string,
  taskName: string,
  nestedPipeline: Pipeline,
  executorConfig: TaskExecutorConfig
): void {
  const {
    config,
    runningPipelines,
    failPipeline,
    advanceScheduler,
    updateTaskStatus,
  } = executorConfig

  // Track nested pipeline state for skip behavior
  let nestedSkippedCount = 0
  let nestedCompletedCount = 0

  // Get total tasks from nested pipeline
  const nestedTotalTasks = nestedPipeline[$PIPELINE_INTERNAL].graph.nodes.size

  const commandName =
    config?.command ?? process.env.NODE_ENV === "production" ? "build" : "dev"

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

  // Merge environment variables: pipeline.env -> task.env (from pipeline.toTask config)
  const taskEnv = task[$TASK_INTERNAL].env
  const pipelineEnv = config?.env ?? {}
  const mergedEnv = {
    ...pipelineEnv,
    ...taskEnv,
  }

  // Run the nested pipeline with signal propagation
  nestedPipeline
    .run({
      spawn: executorConfig.spawn,
      command: config?.command,
      strict: config?.strict,
      signal: executorConfig.signal, // Pass signal to nested pipeline
      env: mergedEnv, // Pass merged env to nested pipeline
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

  const { allowSkip, commands, cwd, env: taskEnv } = task[$TASK_INTERNAL]

  const commandName =
    config?.command ?? process.env.NODE_ENV === "production" ? "build" : "dev"
  const commandConfig = commands[commandName]

  // Check if command exists
  if (commandConfig === undefined) {
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

  let command: string
  let readyWhen: ((stdout: string) => boolean) | undefined
  let readyTimeout = Infinity
  let completedTimeout = Infinity
  let teardown: string | undefined
  let commandEnv: Record<string, string> = {}

  if (typeof commandConfig === "string") {
    command = commandConfig
  } else {
    command = commandConfig.run
    readyWhen = commandConfig.readyWhen
    readyTimeout = commandConfig.readyTimeout ?? Infinity
    completedTimeout = commandConfig.completedTimeout ?? Infinity
    teardown = commandConfig.teardown
    commandEnv = commandConfig.env ?? {}
  }

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

  // Merge environment variables in order: process.env -> pipeline.env -> task.env -> command.env
  const accumulatedEnv = {
    ...process.env,
    PATH: accumulatedPath,
    Path: accumulatedPath,
    ...config?.env,
    ...taskEnv,
    ...commandEnv,
  }

  const child = spawnFn(command, {
    cwd: taskCwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
    env: accumulatedEnv,
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
  let completedTimeoutId: NodeJS.Timeout | null = null

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
          PipelineError.TaskReadyTimeout,
          taskName
        )
        // Clear completed timeout if it exists
        if (completedTimeoutId) {
          clearTimeout(completedTimeoutId)
          completedTimeoutId = null
        }
        // Remove from runningTasks before calling failPipeline to prevent it from
        // being marked as "aborted" - this task failed for a specific reason
        runningTasks.delete(taskId)
        // Kill the process since it didn't become ready in time
        try {
          child.kill("SIGTERM")
        } catch {}
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

  // Set up timeout for task completion
  if (completedTimeout !== Infinity) {
    completedTimeoutId = setTimeout(() => {
      // Task didn't complete within the timeout
      const finishedAt = Date.now()
      const pipelineError = new PipelineError(
        `[${taskName}] Task did not complete within ${completedTimeout}ms`,
        PipelineError.TaskCompletedTimeout,
        taskName
      )
      // Clear ready timeout if it exists (to prevent it from firing after we've already failed)
      if (readyTimeoutId) {
        clearTimeout(readyTimeoutId)
        readyTimeoutId = null
      }
      // Remove from runningTasks before calling failPipeline to prevent it from
      // being marked as "aborted" - this task failed for a specific reason
      runningTasks.delete(taskId)
      // Kill the process since it didn't complete in time
      try {
        child.kill("SIGTERM")
      } catch {}
      updateTaskStatus(taskId, {
        status: "failed",
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: pipelineError,
      })
      failPipeline(pipelineError)
    }, completedTimeout)
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
    // Clear completed timeout if it exists
    if (completedTimeoutId) {
      clearTimeout(completedTimeoutId)
      completedTimeoutId = null
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
    // Clear completed timeout if it exists
    if (completedTimeoutId) {
      clearTimeout(completedTimeoutId)
      completedTimeoutId = null
    }

    // Check if task was already marked as failed (e.g., by timeout handlers)
    // If so, don't process the exit event to avoid conflicts
    const currentStats = executorConfig.taskStats.get(taskId)
    if (currentStats?.status === "failed" && currentStats?.error) {
      // Task was already failed, likely by a timeout handler
      // Just return to avoid duplicate error handling
      return
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
