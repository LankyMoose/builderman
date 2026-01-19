import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL, $PIPELINE_INTERNAL } from "./constants.js"
import { PipelineError } from "../errors.js"

import type { Task, Pipeline } from "../types.js"
import type { ExecutionContext } from "./execution-context.js"

/**
 * Callbacks for task execution events that replace scheduler coordination.
 * These callbacks are invoked by the task executor to notify the queue manager
 * of task state changes, enabling queue-based execution flow.
 */
export interface TaskExecutionCallbacks {
  /**
   * Called when a task becomes ready (e.g., via readyWhen condition).
   * This allows dependent tasks to start executing.
   */
  onTaskReady: (taskId: string) => void
  /**
   * Called when a task completes successfully.
   * Updates dependent task dependency counts and moves ready tasks to execution queue.
   */
  onTaskComplete: (taskId: string) => void
  /**
   * Called when a task fails.
   * Triggers pipeline failure and cleanup.
   */
  onTaskFailed: (taskId: string, error: Error) => void
  /**
   * Called when a task is skipped (e.g., missing command in non-strict mode).
   * Treated similarly to completion for dependency resolution.
   */
  onTaskSkipped: (taskId: string) => void
}

/**
 * Executes a task (either a regular task or a nested pipeline).
 */
export function executeTask(
  task: Task,
  context: ExecutionContext,
  callbacks: TaskExecutionCallbacks
): void {
  // Check if signal is aborted before starting new tasks
  if (context.signal?.aborted) {
    callbacks.onTaskFailed(
      task[$TASK_INTERNAL].id,
      new PipelineError("Aborted", PipelineError.Aborted)
    )
    return
  }

  const {
    name: taskName,
    [$TASK_INTERNAL]: { id, pipeline },
  } = task

  // Handle pipeline tasks
  if (pipeline) {
    executeNestedPipeline(task, id, taskName, pipeline, context, callbacks)
    return
  }

  // Regular task execution
  executeRegularTask(task, id, taskName, context, callbacks)
}

function executeNestedPipeline(
  task: Task,
  taskId: string,
  taskName: string,
  nestedPipeline: Pipeline,
  context: ExecutionContext,
  callbacks: TaskExecutionCallbacks
): void {
  const { config } = context

  // Track nested pipeline state for skip behavior
  let nestedSkippedCount = 0
  let nestedCompletedCount = 0

  // Get total tasks from nested pipeline
  const nestedTotalTasks = nestedPipeline[$PIPELINE_INTERNAL].graph.nodes.size

  const commandName =
    config?.command ?? (process.env.NODE_ENV === "production" ? "build" : "dev")

  // Mark as running - nested pipeline tasks handle their own ready state
  // We don't call onTaskReady here because dependent tasks should wait for
  // the nested pipeline to complete, not just start
  const startedAt = Date.now()
  context.updateTaskStatus(taskId, {
    status: "running",
    command: commandName,
    startedAt,
  })
  config?.onTaskBegin?.(taskName)

  // Create an abort controller to stop the nested pipeline if needed
  let pipelineStopped = false

  // Merge environment variables: pipeline.env -> task.env (from pipeline.toTask config)
  const taskEnv = task[$TASK_INTERNAL].env
  const pipelineEnv = config?.env ?? {}
  const mergedEnv = {
    ...pipelineEnv,
    ...taskEnv,
  }

  // Run the nested pipeline with signal propagation
  // Pass the command from parent pipeline to nested pipeline
  // If undefined, nested pipeline will use its own default (build/dev based on NODE_ENV)
  nestedPipeline
    .run({
      spawn: context.spawn,
      command: config?.command, // Pass command to nested pipeline
      strict: config?.strict,
      signal: context.signal, // Pass signal to nested pipeline
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

      if (!result.ok) {
        // Nested pipeline failed
        const finishedAt = Date.now()
        context.updateTaskStatus(taskId, {
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: result.error,
        })
        callbacks.onTaskFailed(taskId, result.error)
        return
      }

      // Determine nested pipeline result based on skip behavior:
      // - If all inner tasks are skipped → outer task is skipped
      // - If some run, some skip → outer task is completed
      // - If any fail → outer task fails (handled above)
      if (nestedSkippedCount === nestedTotalTasks && nestedTotalTasks > 0) {
        // All tasks were skipped
        const finishedAt = Date.now()
        context.updateTaskStatus(taskId, {
          status: "skipped",
          finishedAt,
          durationMs: finishedAt - startedAt,
        })
        config?.onTaskSkipped?.(taskName, commandName)
        setImmediate(() => {
          callbacks.onTaskSkipped(taskId)
        })
      } else {
        // Some tasks ran (and completed successfully)
        const finishedAt = Date.now()
        context.updateTaskStatus(taskId, {
          status: "completed",
          finishedAt,
          durationMs: finishedAt - startedAt,
        })
        config?.onTaskComplete?.(taskName)
        // Mark as complete - this will update dependent tasks and allow them to start
        callbacks.onTaskComplete(taskId)
      }
    })
}

function executeRegularTask(
  task: Task,
  taskId: string,
  taskName: string,
  context: ExecutionContext,
  callbacks: TaskExecutionCallbacks
): void {
  const {
    config,
    spawn: spawnFn,
    signal,
    teardownManager,
    timeoutManager,
  } = context

  const { allowSkip, commands, cwd, env: taskEnv } = task[$TASK_INTERNAL]

  const commandName =
    config?.command ?? (process.env.NODE_ENV === "production" ? "build" : "dev")
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
      context.updateTaskStatus(taskId, {
        status: "failed",
        command: commandName,
        finishedAt,
        error,
      })
      callbacks.onTaskFailed(taskId, error)
      return
    }

    // Skip the task
    const finishedAt = Date.now()
    context.updateTaskStatus(taskId, {
      status: "skipped",
      command: commandName,
      finishedAt,
      durationMs: 0,
    })
    config?.onTaskSkipped?.(taskName, commandName)
    // Mark as skipped - this satisfies dependencies and unblocks dependents
    // Use setImmediate to ensure scheduler is at idle yield before receiving skip
    setImmediate(() => {
      callbacks.onTaskSkipped(taskId)
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
    context.updateTaskStatus(taskId, {
      status: "failed",
      command: commandName,
      finishedAt,
      durationMs: 0,
      error: pipelineError,
    })
    callbacks.onTaskFailed(taskId, pipelineError)
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

  // Update the running task execution with the process
  const runningTasks = context.queueManager.getRunningTasks()
  const execution = runningTasks.get(taskId)!
  execution.process = child
  context.queueManager.markTaskRunning(taskId, execution)

  const startedAt = Date.now()
  context.updateTaskStatus(taskId, {
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

  // For tasks without readyWhen, we wait for the process to exit successfully
  // before allowing dependent tasks to start. This ensures dependencies are
  // fully completed before dependents begin execution.
  if (readyWhen && readyTimeout !== Infinity) {
    // Set up timeout for readyWhen condition using TimeoutManager
    timeoutManager.setReadyTimeout(taskId, readyTimeout, () => {
      if (!didMarkReady) {
        const finishedAt = Date.now()
        const pipelineError = new PipelineError(
          `[${taskName}] Task did not become ready within ${readyTimeout}ms`,
          PipelineError.TaskReadyTimeout,
          taskName
        )
        // Clear completion timeout if it exists
        timeoutManager.clearCompletionTimeout(taskId)
        // Kill the process since it didn't become ready in time
        try {
          child.kill("SIGTERM")
        } catch {}
        context.updateTaskStatus(taskId, {
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: pipelineError,
        })
        callbacks.onTaskFailed(taskId, pipelineError)
      }
    })
  }

  // Set up timeout for task completion using TimeoutManager
  if (completedTimeout !== Infinity) {
    timeoutManager.setCompletionTimeout(taskId, completedTimeout, () => {
      // Task didn't complete within the timeout
      const finishedAt = Date.now()
      const pipelineError = new PipelineError(
        `[${taskName}] Task did not complete within ${completedTimeout}ms`,
        PipelineError.TaskCompletedTimeout,
        taskName
      )
      // Clear ready timeout if it exists (to prevent it from firing after we've already failed)
      timeoutManager.clearReadyTimeout(taskId)
      // Kill the process since it didn't complete in time
      try {
        child.kill("SIGTERM")
      } catch {}
      context.updateTaskStatus(taskId, {
        status: "failed",
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: pipelineError,
      })
      callbacks.onTaskFailed(taskId, pipelineError)
    })
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
      timeoutManager.clearReadyTimeout(taskId)
      callbacks.onTaskReady(taskId)
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

    // Clear all timeouts for this task
    timeoutManager.clearTaskTimeouts(taskId)

    const finishedAt = Date.now()
    const pipelineError = new PipelineError(
      `[${taskName}] Failed to start: ${error.message}`,
      PipelineError.TaskFailed,
      taskName
    )
    context.updateTaskStatus(taskId, {
      status: "failed",
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: pipelineError,
    })
    callbacks.onTaskFailed(taskId, pipelineError)
  })

  child.on("exit", (code: number | null, signal: string | null) => {
    // Clear all timeouts for this task
    timeoutManager.clearTaskTimeouts(taskId)

    // Check if task was already marked as failed (e.g., by timeout handlers)
    // If so, don't process the exit event to avoid conflicts
    const currentStats = context.taskStats.get(taskId)
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
      context.updateTaskStatus(taskId, {
        status: "failed",
        finishedAt,
        durationMs,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        error: pipelineError,
      })
      callbacks.onTaskFailed(taskId, pipelineError)
      return
    }

    context.updateTaskStatus(taskId, {
      status: "completed",
      finishedAt,
      durationMs,
      exitCode: code ?? 0,
    })
    config?.onTaskComplete?.(taskName)

    // 🔑 Notify scheduler and drain newly runnable tasks
    callbacks.onTaskComplete(taskId)
  })
}
