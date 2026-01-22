import * as path from "node:path"
import * as fs from "node:fs"
import { createHash } from "node:crypto"

import {
  $TASK_INTERNAL,
  $PIPELINE_INTERNAL,
  CACHE_DIR,
  CACHE_VERSION,
} from "./constants.js"
import { PipelineError } from "../errors.js"
import { parseCommandLine, resolveExecutable } from "./util.js"

import type { Task, Pipeline, CommandCacheConfig, Artifact } from "../types.js"
import type { ExecutionContext } from "./execution-context.js"
import type { InputResolver, ResolveContext } from "../resolvers/types.js"

/**
 * Internal cache config with artifacts and resolvers separated from inputs.
 */
type InternalCacheConfig = CommandCacheConfig & {
  artifacts?: Artifact[]
  resolvers?: InputResolver[]
}

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
  // Track unique tasks that are ready, complete, or skipped
  // A task can be both ready and complete, so we use Sets to avoid double-counting
  const readyOrCompleteTasks = new Set<string>()
  // Track all task IDs that we've seen in the nested pipeline
  // This includes tasks with transitive dependencies, not just root tasks
  const allSeenTasks = new Set<string>()
  // Track root task IDs from the nested pipeline to know when all root tasks are ready
  // We need to wait for all root tasks to be ready before marking the outer task as ready
  const rootTaskIds = new Set<string>()
  let rootTasksInitialized = false
  let didMarkOuterReady = false

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
  config?.onTaskBegin?.(taskName, taskId)

  // Create an abort controller to stop the nested pipeline if needed
  let pipelineStopped = false

  const taskInternal = task[$TASK_INTERNAL]

  // Merge environment variables: pipeline.env -> task.env (from pipeline.toTask config)
  const taskEnv = taskInternal.env
  const pipelineEnv = config?.env ?? {}
  const mergedEnv = {
    ...pipelineEnv,
    ...taskEnv,
  }

  // Helper to check if all inner tasks are ready/complete/skipped
  const checkAllInnerTasksReady = () => {
    if (didMarkOuterReady) return
    // We need to wait for all root tasks to be ready/complete/skipped before marking
    // the outer task as ready. This ensures dependents don't start until all root
    // tasks in the nested pipeline are ready.
    //
    // We need to be careful about race conditions: a root task might become ready
    // before another root task has begun. To handle this, we must wait until we've
    // seen all expected root tasks begin before we can safely check if they're all ready.
    const expectedRootTaskCount = rootTaskNames.size

    // Don't check readiness until we've seen all expected root tasks begin
    // (some might be excluded, but we'll handle that by checking if we've seen
    // enough tasks or if the pipeline has progressed enough)
    if (!rootTasksInitialized || rootTaskIds.size === 0) {
      // Haven't seen any root tasks yet - wait
      return
    }

    // Critical: We must wait until we've seen ALL expected root tasks begin
    // before we can safely check if they're all ready. This prevents race conditions
    // where one root task becomes ready before another has begun.
    if (rootTaskIds.size < expectedRootTaskCount) {
      // Haven't seen all root tasks begin yet - wait for them
      return
    }

    // Now that we've seen all root tasks begin, check if they're all ready/complete/skipped
    // We must verify that EVERY root task that has begun is also ready/complete/skipped
    // This is critical: we cannot mark the nested task as ready until ALL root tasks are ready
    let allRootTasksReady = true
    for (const rootTaskId of rootTaskIds) {
      if (!readyOrCompleteTasks.has(rootTaskId)) {
        // This root task has begun but is not yet ready/complete/skipped
        // We must wait for it before marking the nested task as ready
        allRootTasksReady = false
        break
      }
    }

    // Only mark as ready if:
    // 1. All root tasks that have begun are ready/complete/skipped
    // 2. We've seen all expected root tasks begin
    // 3. We haven't already marked as ready
    // 4. The nested task is actually running (in runningTasks)
    //    This ensures the queue manager can properly unblock dependents
    if (allRootTasksReady && rootTaskIds.size === expectedRootTaskCount) {
      // Verify the task is in runningTasks before marking as ready
      // This is important for the queue manager to properly unblock dependents
      const runningTasks = context.queueManager.getRunningTasks()
      if (runningTasks.has(taskId)) {
        didMarkOuterReady = true
        // Mark outer task as ready - this allows dependents to proceed
        callbacks.onTaskReady(taskId)
      }
    }
  }

  // Get task-level dependencies of the pipeline task to exclude from nested graph
  // These dependencies are already satisfied by the outer pipeline
  const excludeTasks = taskInternal.pipeline
    ? new Set(taskInternal.dependencies)
    : undefined

  // Get root tasks from the nested pipeline to track when they're all ready
  const nestedPipelineInternal = nestedPipeline[$PIPELINE_INTERNAL]
  const rootTasks = nestedPipelineInternal?.tasks ?? []
  const rootTaskNames = new Set(
    rootTasks.map((t: Task) => t[$TASK_INTERNAL].name)
  )

  // Run the nested pipeline with signal propagation
  // Pass the command from parent pipeline to nested pipeline
  // If undefined, nested pipeline will use its own default (build/dev based on NODE_ENV)
  // Also pass excludeTasks to prevent including already-satisfied dependencies
  nestedPipeline
    .run({
      spawn: context.spawn,
      command: config?.command, // Pass command to nested pipeline
      strict: config?.strict,
      signal: context.signal, // Pass signal to nested pipeline
      env: mergedEnv, // Pass merged env to nested pipeline
      excludeTasks, // Exclude already-satisfied dependencies from nested graph
      onTaskBegin: (nestedTaskName, nestedTaskId) => {
        if (pipelineStopped) return
        // Track all tasks we've seen (including transitive dependencies)
        allSeenTasks.add(nestedTaskId)
        // Track root tasks by matching task name
        // Root tasks are the tasks passed to pipeline(), which should have unique names
        if (rootTaskNames.has(nestedTaskName)) {
          rootTaskIds.add(nestedTaskId)
          rootTasksInitialized = true
          // Don't check readiness here - tasks aren't ready when they begin
          // We'll check readiness when tasks become ready/complete/skipped
        }
        config?.onTaskBegin?.(`${taskName}:${nestedTaskName}`, nestedTaskId)
      },
      onTaskReady: (nestedTaskName, nestedTaskId) => {
        if (pipelineStopped) return
        // Track this task as ready (it may later become complete, but we only count it once)
        readyOrCompleteTasks.add(nestedTaskId)
        // Use setImmediate to defer the readiness check to ensure all synchronous
        // onTaskBegin callbacks have completed. This prevents race conditions where
        // a task becomes ready before another task's onTaskBegin has finished executing.
        // This is especially important when tasks start in parallel.
        setImmediate(() => {
          if (!pipelineStopped) {
            checkAllInnerTasksReady()
          }
        })
        config?.onTaskReady?.(`${taskName}:${nestedTaskName}`, nestedTaskId)
      },
      onTaskComplete: (nestedTaskName, nestedTaskId) => {
        if (pipelineStopped) return
        nestedCompletedCount++
        // Track this task as complete (if it was already ready, the Set prevents double-counting)
        readyOrCompleteTasks.add(nestedTaskId)
        // Use setImmediate to defer the readiness check
        setImmediate(() => {
          if (!pipelineStopped) {
            checkAllInnerTasksReady()
          }
        })
        config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`, nestedTaskId)
      },
      onTaskSkipped: (nestedTaskName, nestedTaskId, mode, reason) => {
        if (pipelineStopped) return
        nestedSkippedCount++
        // Track skipped tasks in both sets
        // (they're finished, just in a different way)
        allSeenTasks.add(nestedTaskId)
        readyOrCompleteTasks.add(nestedTaskId)
        // Track root tasks if this is a root task that was skipped
        if (rootTaskNames.has(nestedTaskName)) {
          rootTaskIds.add(nestedTaskId)
          rootTasksInitialized = true
        }
        // Use setImmediate to defer the readiness check
        setImmediate(() => {
          if (!pipelineStopped) {
            checkAllInnerTasksReady()
          }
        })
        config?.onTaskSkipped?.(
          `${taskName}:${nestedTaskName}`,
          nestedTaskId,
          mode,
          reason
        )
      },
    })
    .then((result) => {
      if (pipelineStopped) return

      if (!result.ok) {
        // Nested pipeline failed
        const finishedAt = Date.now()
        // Capture nested pipeline task stats even on failure
        const nestedTaskStats = result.stats.tasks
        context.updateTaskStatus(taskId, {
          status: "failed",
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: result.error,
          subtasks: nestedTaskStats,
        })
        callbacks.onTaskFailed(taskId, result.error)
        return
      }

      // Capture nested pipeline task stats for subtasks field
      const nestedTaskStats = result.stats.tasks

      // Determine nested pipeline result based on skip behavior:
      // - If all inner tasks are skipped → outer task is skipped
      // - If some run, some skip → outer task is completed
      // - If any fail → outer task fails (handled above)
      // Use the nested pipeline's summary to get accurate counts
      // This accounts for transitive dependencies that weren't in the root tasks
      const actualSkippedCount = result.stats.summary.skipped
      const actualTotalTasks = result.stats.summary.total
      if (actualSkippedCount === actualTotalTasks && actualTotalTasks > 0) {
        // All tasks were skipped
        const finishedAt = Date.now()
        context.updateTaskStatus(taskId, {
          status: "skipped",
          finishedAt,
          durationMs: finishedAt - startedAt,
          subtasks: nestedTaskStats,
        })
        config?.onTaskSkipped?.(
          taskName,
          taskId,
          commandName,
          "inner-tasks-skipped"
        )
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
          subtasks: nestedTaskStats,
        })
        config?.onTaskComplete?.(taskName, taskId)
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
    config?.onTaskSkipped?.(taskName, taskId, commandName, "command-not-found")
    // Mark as skipped - this satisfies dependencies and unblocks dependents
    // Use setImmediate to ensure scheduler is at idle yield before receiving skip
    setImmediate(() => {
      callbacks.onTaskSkipped(taskId)
    })
    return
  }

  let commandString: string
  let readyWhen: ((stdout: string) => boolean) | undefined
  let readyTimeout = Infinity
  let completedTimeout = Infinity
  let teardown: string | undefined
  let commandEnv: Record<string, string> = {}
  let cacheConfig: InternalCacheConfig | undefined

  if (typeof commandConfig === "string") {
    commandString = commandConfig
  } else {
    commandString = commandConfig.run
    readyWhen = commandConfig.readyWhen
    readyTimeout = commandConfig.readyTimeout ?? Infinity
    completedTimeout = commandConfig.completedTimeout ?? Infinity
    teardown = commandConfig.teardown
    commandEnv = commandConfig.env ?? {}
    cacheConfig = commandConfig.cache
  }

  // Parse commandSpec into cmd + args
  const { cmd, args } = parseCommandLine(commandString)

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

  // Merge environment variables in order: process.env -> pipeline.env -> task.env -> command.env
  const accumulatedEnv = {
    ...process.env,
    // We'll compute PATH/Path below once we've built the accumulatedPath string
    ...config?.env,
    ...taskEnv,
    ...commandEnv,
  }

  const accumulatedPath = [
    path.join(taskCwd, "node_modules", ".bin"),
    path.join(process.cwd(), "node_modules", ".bin"),
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(process.platform === "win32" ? ";" : ":")

  // Ensure PATH is set consistently (Windows is case-insensitive)
  accumulatedEnv.PATH = accumulatedPath
  accumulatedEnv.Path = accumulatedPath

  let finalCmd: string
  let finalArgs: string[]

  if (
    process.platform === "win32" &&
    !cmd.includes("\\") &&
    !cmd.includes("/")
  ) {
    // On Windows, for bare commands like "pnpm" we delegate resolution to cmd.exe
    // so that PATHEXT and other shell semantics are respected. This closely matches
    // Node's spawn behavior when using shell: true, but keeps a consistent API.
    finalCmd = process.env.ComSpec || "cmd.exe"
    finalArgs = ["/d", "/s", "/c", commandString]
  } else {
    // Resolve executable from PATH (needed when shell: false)
    const { cmd: resolvedCmd, needsCmdWrapper } = resolveExecutable(
      cmd,
      accumulatedPath
    )

    finalCmd = resolvedCmd
    finalArgs = args

    // On Windows, .cmd and .bat files need to be run via cmd.exe when shell: false
    if (needsCmdWrapper) {
      finalCmd = process.env.ComSpec || "cmd.exe"
      finalArgs = ["/c", resolvedCmd, ...args]
    }
  }

  // If caching is enabled for this command, attempt a cache-based skip
  let taskCacheFile: string | undefined
  if (cacheConfig) {
    const cacheRoot = path.resolve(process.cwd(), CACHE_DIR)
    const cacheDir = path.join(cacheRoot, "cache", `v${CACHE_VERSION}`)
    taskCacheFile = path.join(
      cacheDir,
      `${sanitizeFileName(taskName)}-${sanitizeFileName(commandName)}.json`
    )

    // Initialize cache info in task stats
    // After processing in task.ts, inputs only contains strings (artifacts are separated)
    const inputPaths = (cacheConfig.inputs ?? []) as string[]
    const outputPaths = cacheConfig.outputs ?? []

    context.updateTaskStatus(taskId, {
      cache: {
        checked: false,
        cacheFile: taskCacheFile,
        inputs: inputPaths,
        outputs: outputPaths,
      },
    })

    try {
      // Ensure cache directory exists
      fs.mkdirSync(path.dirname(taskCacheFile), { recursive: true })

      // Get artifact identifiers from cache inputs for this command
      const consumedArtifactIdentifiers = getConsumedArtifactIdentifiers(
        task,
        commandName,
        context
      )

      // If we can't get artifact identifiers (e.g., dependencies haven't run yet),
      // we can't use the cache - must run the task
      if (consumedArtifactIdentifiers === null) {
        // Cache miss - can't determine if cache is valid without artifact identifiers
        context.updateTaskStatus(taskId, {
          cache: {
            checked: true,
            hit: false,
            cacheFile: taskCacheFile,
            inputs: inputPaths,
            outputs: outputPaths,
          },
        })
        // Don't return - continue to execute the task
      } else {
        const previousSnapshot = readSnapshot(taskCacheFile)
        const hasArtifactInputs = consumedArtifactIdentifiers.size > 0
        const currentSnapshot = createSnapshot(
          taskCwd,
          cacheConfig,
          hasArtifactInputs ? consumedArtifactIdentifiers : undefined
        )

        // If we have artifact inputs, we must compare them
        // If the previous snapshot doesn't have artifact inputs, it's a cache miss
        if (hasArtifactInputs) {
          if (!previousSnapshot || !previousSnapshot.artifactInputs) {
            // Cache miss - artifact inputs exist but previous snapshot doesn't have them
            context.updateTaskStatus(taskId, {
              cache: {
                checked: true,
                hit: false,
                cacheFile: taskCacheFile,
                inputs: inputPaths,
                outputs: outputPaths,
              },
            })
            // Don't return - continue to execute the task
          } else if (
            previousSnapshot &&
            snapshotsEqual(previousSnapshot, currentSnapshot)
          ) {
            // Snapshots match including artifact inputs - cache hit
            const finishedAt = Date.now()
            context.updateTaskStatus(taskId, {
              status: "skipped",
              command: commandName,
              finishedAt,
              durationMs: 0,
              cache: {
                checked: true,
                hit: true,
                cacheFile: taskCacheFile,
                inputs: inputPaths,
                outputs: outputPaths,
              },
            })
            config?.onTaskSkipped?.(taskName, taskId, commandName, "cache-hit")
            setImmediate(() => {
              callbacks.onTaskSkipped(taskId)
            })
            return
          }
          // Artifact inputs exist but don't match - cache miss, continue execution
        } else if (
          previousSnapshot &&
          snapshotsEqual(previousSnapshot, currentSnapshot)
        ) {
          // No artifact dependencies and snapshots match - cache hit
          const finishedAt = Date.now()
          context.updateTaskStatus(taskId, {
            status: "skipped",
            command: commandName,
            finishedAt,
            durationMs: 0,
            cache: {
              checked: true,
              hit: true,
              cacheFile: taskCacheFile,
              inputs: inputPaths,
              outputs: outputPaths,
            },
          })
          config?.onTaskSkipped?.(taskName, taskId, commandName, "cache-hit")
          setImmediate(() => {
            callbacks.onTaskSkipped(taskId)
          })
          return
        }

        // Cache miss - update stats to indicate cache was checked but didn't hit
        context.updateTaskStatus(taskId, {
          cache: {
            checked: true,
            hit: false,
            cacheFile: taskCacheFile,
            inputs: inputPaths,
            outputs: outputPaths,
          },
        })
        // Don't write snapshot here - wait until task completes successfully
      }
    } catch {
      // Cache failures must never break task execution. Fall through to normal run.
      taskCacheFile = undefined
    }
  }

  const child = spawnFn(finalCmd, finalArgs, {
    cwd: taskCwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
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
    const teardownSpec = parseCommandLine(teardown)
    teardownManager.register(taskId, {
      cmd: teardownSpec.cmd,
      args: teardownSpec.args,
      cwd: taskCwd,
      taskName,
    })
  }

  config?.onTaskBegin?.(taskName, taskId)

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

    // If caching is enabled, write the snapshot after successful completion
    if (cacheConfig && taskCacheFile) {
      try {
        // Get artifact identifiers again (in case they changed during execution)
        const consumedArtifactIdentifiers = getConsumedArtifactIdentifiers(
          task,
          commandName,
          context
        )
        const completedSnapshot = createSnapshot(
          taskCwd,
          cacheConfig,
          consumedArtifactIdentifiers || undefined
        )
        writeSnapshot(taskCacheFile, completedSnapshot)
      } catch {
        // Cache failures must never break task execution
      }
    }

    context.updateTaskStatus(taskId, {
      status: "completed",
      finishedAt,
      durationMs,
      exitCode: code ?? 0,
    })
    config?.onTaskComplete?.(taskName, taskId)

    // 🔑 Notify scheduler and drain newly runnable tasks
    callbacks.onTaskComplete(taskId)
  })
}

interface FileMetadata {
  path: string
  mtimeMs: number
  size: number
}

interface Snapshot {
  version: number
  cwd: string
  /**
   * Unique identifier for this snapshot.
   * Generated when the task completes and changes when outputs change.
   * Used to track artifact state across runs.
   */
  identifier: string
  inputs: FileMetadata[]
  outputs: FileMetadata[]
  /**
   * Artifact references from cache inputs.
   * Object mapping "taskName:commandName" to the identifier of the consumed artifact.
   * Only present if the task has artifact inputs.
   * Stored as object (not Map) for JSON serialization.
   */
  artifactInputs?: Record<string, string>
  /**
   * Virtual inputs from resolvers.
   * Object mapping resolver kind to their computed hashes.
   * Only present if the task has resolver inputs.
   */
  virtualInputs?: Record<string, string>
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function collectFileMetadata(root: string, relPath: string): FileMetadata[] {
  const fullPath = path.isAbsolute(relPath) ? relPath : path.join(root, relPath)

  if (!fs.existsSync(fullPath)) {
    return []
  }

  const stats = fs.statSync(fullPath)
  if (stats.isDirectory()) {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    const results: FileMetadata[] = []
    for (const entry of entries) {
      const childRel = path.join(relPath, entry.name)
      results.push(...collectFileMetadata(root, childRel))
    }
    return results
  }

  if (!stats.isFile()) {
    return []
  }

  return [
    {
      path: path.relative(root, fullPath).replace(/\\/g, "/"),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    },
  ]
}

/**
 * Generates a unique identifier for a snapshot based on its outputs.
 * This identifier changes when outputs change, providing a "solid state" for artifacts.
 */
function generateSnapshotIdentifier(outputs: FileMetadata[]): string {
  if (outputs.length === 0) {
    return ""
  }

  const hash = createHash("sha256")
  hash.update(`${CACHE_VERSION}:`)

  // Hash all output file metadata
  for (const output of outputs) {
    hash.update(`${output.path}:${output.mtimeMs}:${output.size}:`)
  }

  return hash.digest("hex")
}

function createSnapshot(
  taskCwd: string,
  cacheConfig: InternalCacheConfig,
  artifactInputs?: Map<string, string>
): Snapshot {
  const inputs: FileMetadata[] = []
  const outputs: FileMetadata[] = []
  const virtualInputs: Record<string, string> = {}

  // After processing in task.ts, inputs only contains strings (artifacts and resolvers are separated)
  const inputPaths = (cacheConfig.inputs ?? []) as string[]
  const outputPaths = cacheConfig.outputs ?? []

  // Resolve resolvers to concrete inputs
  if (cacheConfig.resolvers && cacheConfig.resolvers.length > 0) {
    const resolveContext: ResolveContext = {
      taskCwd,
      rootCwd: process.cwd(),
    }

    for (const resolver of cacheConfig.resolvers) {
      const resolved = resolver.resolve(resolveContext)
      for (const resolvedInput of resolved) {
        if (resolvedInput.type === "file") {
          // Add file inputs to the inputs array
          inputs.push(...collectFileMetadata(taskCwd, resolvedInput.path))
        } else if (resolvedInput.type === "virtual") {
          // Store virtual inputs with their kind and hash
          virtualInputs[`${resolvedInput.kind}:${resolvedInput.description}`] =
            resolvedInput.hash
        }
      }
    }
  }

  for (const p of inputPaths) {
    inputs.push(...collectFileMetadata(taskCwd, p))
  }
  for (const p of outputPaths) {
    outputs.push(...collectFileMetadata(taskCwd, p))
  }

  const sortByPath = (a: FileMetadata, b: FileMetadata) =>
    a.path.localeCompare(b.path)

  inputs.sort(sortByPath)
  outputs.sort(sortByPath)

  // Generate unique identifier based on outputs
  const identifier = generateSnapshotIdentifier(outputs)

  const snapshot: Snapshot = {
    version: CACHE_VERSION,
    cwd: taskCwd,
    identifier,
    inputs,
    outputs,
  }

  if (artifactInputs) {
    // Convert Map to object for JSON serialization if needed
    if (artifactInputs instanceof Map) {
      if (artifactInputs.size > 0) {
        snapshot.artifactInputs = Object.fromEntries(artifactInputs)
      }
    } else {
      snapshot.artifactInputs = artifactInputs
    }
  }

  if (Object.keys(virtualInputs).length > 0) {
    snapshot.virtualInputs = virtualInputs
  }

  return snapshot
}

function readSnapshot(cacheFile: string): Snapshot | null {
  if (!fs.existsSync(cacheFile)) {
    return null
  }
  try {
    const data = fs.readFileSync(cacheFile, "utf8")
    const parsed = JSON.parse(data) as Snapshot
    if (parsed.version !== CACHE_VERSION) {
      return null
    }
    // Backward compatibility: if snapshot doesn't have identifier, generate one from outputs
    if (!parsed.identifier) {
      parsed.identifier = generateSnapshotIdentifier(parsed.outputs)
    }
    return parsed
  } catch {
    return null
  }
}

function writeSnapshot(cacheFile: string, snapshot: Snapshot): void {
  const tmpFile = `${cacheFile}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmpFile, JSON.stringify(snapshot), "utf8")
  fs.renameSync(tmpFile, cacheFile)
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.version !== b.version) return false
  if (a.cwd !== b.cwd) return false

  if (a.inputs.length !== b.inputs.length) return false
  if (a.outputs.length !== b.outputs.length) return false

  for (let i = 0; i < a.inputs.length; i++) {
    const fa = a.inputs[i]!
    const fb = b.inputs[i]!
    if (
      fa.path !== fb.path ||
      fa.mtimeMs !== fb.mtimeMs ||
      fa.size !== fb.size
    ) {
      return false
    }
  }

  for (let i = 0; i < a.outputs.length; i++) {
    const fa = a.outputs[i]!
    const fb = b.outputs[i]!
    if (
      fa.path !== fb.path ||
      fa.mtimeMs !== fb.mtimeMs ||
      fa.size !== fb.size
    ) {
      return false
    }
  }

  // Compare identifiers - they must match
  if (a.identifier !== b.identifier) {
    return false
  }

  // Compare artifact inputs
  const aArtifactInputs = a.artifactInputs
  const bArtifactInputs = b.artifactInputs

  // If one has artifact inputs and the other doesn't, they're different
  if (
    (aArtifactInputs && !bArtifactInputs) ||
    (!aArtifactInputs && bArtifactInputs)
  ) {
    return false
  }

  // If both have artifact inputs, compare them
  if (aArtifactInputs && bArtifactInputs) {
    const aKeys = Object.keys(aArtifactInputs).sort()
    const bKeys = Object.keys(bArtifactInputs).sort()

    if (aKeys.length !== bKeys.length) return false

    for (const key of aKeys) {
      if (aArtifactInputs[key] !== bArtifactInputs[key]) {
        return false
      }
    }
  }

  // Compare virtual inputs (from resolvers)
  const aVirtualInputs = a.virtualInputs
  const bVirtualInputs = b.virtualInputs

  // If one has virtual inputs and the other doesn't, they're different
  if (
    (aVirtualInputs && !bVirtualInputs) ||
    (!aVirtualInputs && bVirtualInputs)
  ) {
    return false
  }

  // If both have virtual inputs, compare them
  if (aVirtualInputs && bVirtualInputs) {
    const aKeys = Object.keys(aVirtualInputs).sort()
    const bKeys = Object.keys(bVirtualInputs).sort()

    if (aKeys.length !== bKeys.length) return false

    for (const key of aKeys) {
      if (aVirtualInputs[key] !== bVirtualInputs[key]) {
        return false
      }
    }
  }

  return true
}

/**
 * Gets the artifact identifier for a consumed task command.
 * Reads the identifier from the consumed task's cache file (written after completion).
 * Returns null if the task doesn't have cache config, the command doesn't exist, or the cache file doesn't exist.
 */
function getArtifactIdentifier(
  consumedTask: Task,
  commandName: string,
  _context: ExecutionContext
): string | null {
  const { name: consumedTaskName, commands } = consumedTask[$TASK_INTERNAL]
  const commandConfig = commands[commandName]

  if (!commandConfig) {
    return null
  }

  // Only tasks with cache config can produce artifacts
  const cacheConfig =
    typeof commandConfig === "string" ? undefined : commandConfig.cache
  if (
    !cacheConfig ||
    !cacheConfig.outputs ||
    cacheConfig.outputs.length === 0
  ) {
    return null
  }

  // Read the artifact identifier from the consumed task's cache file
  // This is the authoritative identifier computed when the task completed
  const cacheRoot = path.resolve(process.cwd(), CACHE_DIR)
  const cacheDir = path.join(cacheRoot, "cache", `v${CACHE_VERSION}`)
  const consumedCacheFile = path.join(
    cacheDir,
    `${sanitizeFileName(consumedTaskName)}-${sanitizeFileName(
      commandName
    )}.json`
  )

  const snapshot = readSnapshot(consumedCacheFile)
  if (!snapshot) {
    // Cache file doesn't exist yet
    return null
  }

  // readSnapshot always generates an identifier if missing (for backward compatibility)
  // So snapshot.identifier should always exist after readSnapshot
  // Empty string is valid (means no outputs), so we allow it
  // Only return null if identifier is actually missing (undefined/null)
  if (snapshot.identifier === undefined || snapshot.identifier === null) {
    // This shouldn't happen, but handle it gracefully
    return null
  }

  return snapshot.identifier
}

/**
 * Gets artifact identifiers for all consumed artifacts (extracted from cache.inputs).
 * Returns a map from "taskName:commandName" to identifier, or null if any artifact
 * doesn't have an identifier yet.
 */
function getConsumedArtifactIdentifiers(
  task: Task,
  commandName: string,
  context: ExecutionContext
): Map<string, string> | null {
  const { commands } = task[$TASK_INTERNAL]
  const commandConfig = commands[commandName]
  if (!commandConfig || typeof commandConfig === "string") {
    return new Map()
  }

  const cacheConfig = commandConfig.cache as InternalCacheConfig | undefined
  if (
    !cacheConfig ||
    !cacheConfig.artifacts ||
    cacheConfig.artifacts.length === 0
  ) {
    return new Map()
  }

  const identifiers = new Map<string, string>()

  for (const artifact of cacheConfig.artifacts) {
    const consumedTaskName = artifact.task[$TASK_INTERNAL].name
    const consumedCommandName = artifact.command
    const key = `${consumedTaskName}:${consumedCommandName}`

    const identifier = getArtifactIdentifier(
      artifact.task,
      consumedCommandName,
      context
    )

    if (identifier === null) {
      // If any consumed artifact doesn't have an identifier yet, we can't use cache
      return null
    }

    identifiers.set(key, identifier)
  }

  return identifiers
}
