import * as path from "node:path"
import * as fs from "node:fs"

import {
  $TASK_INTERNAL,
  $PIPELINE_INTERNAL,
  CACHE_DIR,
  CACHE_VERSION,
} from "./constants.js"
import { PipelineError } from "../errors.js"
import { parseCommandLine, resolveExecutable } from "./util.js"

import type { Task, Pipeline, CommandCacheConfig } from "../types.js"
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
  // Track unique tasks that are ready, complete, or skipped
  // A task can be both ready and complete, so we use Sets to avoid double-counting
  const readyOrCompleteTasks = new Set<string>()
  let didMarkOuterReady = false

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
  config?.onTaskBegin?.(taskName, taskId)

  // Create an abort controller to stop the nested pipeline if needed
  let pipelineStopped = false

  // Merge environment variables: pipeline.env -> task.env (from pipeline.toTask config)
  const taskEnv = task[$TASK_INTERNAL].env
  const pipelineEnv = config?.env ?? {}
  const mergedEnv = {
    ...pipelineEnv,
    ...taskEnv,
  }

  // Helper to check if all inner tasks are ready/complete/skipped
  const checkAllInnerTasksReady = () => {
    if (didMarkOuterReady) return
    // Count unique tasks: ready (via readyWhen), complete, or skipped
    // A task can be both ready and complete, so we use a Set to track unique tasks
    const totalFinished = readyOrCompleteTasks.size + nestedSkippedCount
    if (totalFinished === nestedTotalTasks && nestedTotalTasks > 0) {
      didMarkOuterReady = true
      // Mark outer task as ready - this allows dependents to proceed
      callbacks.onTaskReady(taskId)
    }
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
      onTaskBegin: (nestedTaskName, nestedTaskId) => {
        if (pipelineStopped) return
        config?.onTaskBegin?.(`${taskName}:${nestedTaskName}`, nestedTaskId)
      },
      onTaskReady: (_, nestedTaskId) => {
        if (pipelineStopped) return
        // Track this task as ready (it may later become complete, but we only count it once)
        readyOrCompleteTasks.add(nestedTaskId)
        checkAllInnerTasksReady()
        // Note: We don't call config?.onTaskReady here because the nested pipeline
        // already handles that internally. We only track readiness for the outer task.
      },
      onTaskComplete: (nestedTaskName, nestedTaskId) => {
        if (pipelineStopped) return
        nestedCompletedCount++
        // Track this task as complete (if it was already ready, the Set prevents double-counting)
        readyOrCompleteTasks.add(nestedTaskId)
        checkAllInnerTasksReady()
        config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`, nestedTaskId)
      },
      onTaskSkipped: (nestedTaskName, nestedTaskId, mode, reason) => {
        if (pipelineStopped) return
        nestedSkippedCount++
        checkAllInnerTasksReady()
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
      if (nestedSkippedCount === nestedTotalTasks && nestedTotalTasks > 0) {
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
  let cacheConfig: CommandCacheConfig | undefined

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
    const inputPaths = cacheConfig.inputs
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

      const previousSnapshot = readSnapshot(taskCacheFile)
      const currentSnapshot = createSnapshot(taskCwd, cacheConfig)

      if (
        previousSnapshot &&
        snapshotsEqual(previousSnapshot, currentSnapshot)
      ) {
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
        const completedSnapshot = createSnapshot(taskCwd, cacheConfig)
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
  inputs: FileMetadata[]
  outputs: FileMetadata[]
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

function createSnapshot(
  taskCwd: string,
  cacheConfig: import("../types.js").CommandCacheConfig
): Snapshot {
  const inputs: FileMetadata[] = []
  const outputs: FileMetadata[] = []

  const inputPaths = cacheConfig.inputs
  const outputPaths = cacheConfig.outputs ?? []

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

  return {
    version: CACHE_VERSION,
    cwd: taskCwd,
    inputs,
    outputs,
  }
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
    const fa = a.inputs[i]
    const fb = b.inputs[i]
    if (
      fa.path !== fb.path ||
      fa.mtimeMs !== fb.mtimeMs ||
      fa.size !== fb.size
    ) {
      return false
    }
  }

  for (let i = 0; i < a.outputs.length; i++) {
    const fa = a.outputs[i]
    const fb = b.outputs[i]
    if (
      fa.path !== fb.path ||
      fa.mtimeMs !== fb.mtimeMs ||
      fa.size !== fb.size
    ) {
      return false
    }
  }

  return true
}
