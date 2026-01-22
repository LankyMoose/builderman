import type {
  $TASK_INTERNAL,
  $PIPELINE_INTERNAL,
  $ARTIFACT_INTERNAL,
} from "./internal/constants.js"
import type { PipelineError } from "./errors.js"
import type { InputResolver } from "./resolvers/types.js"

/**
 * Configuration for a command to be executed as part of a task.
 */
export interface CommandConfig {
  /**
   * The command string to execute (e.g., "npm run dev" or "node server.js").
   */
  run: string
  /**
   * Optional array of task dependencies for this command.
   * The task's command with the same name must complete before this command can start.
   * For example, if this is the "build" command and you pass a task, it will depend on that task's "build" command.
   */
  dependencies?: Task[]
  /**
   * Optional function that determines when the command is considered "ready".
   * The function receives the accumulated stdout output and should return true
   * when the command has reached a ready state (e.g., server has started).
   * If not provided, the task is marked as ready immediately after the command starts.
   */
  readyWhen?: (stdout: string) => boolean
  /**
   * Maximum time in milliseconds to wait for the command to become ready.
   * Only applies when `readyWhen` is provided.
   * @default Infinity
   */
  readyTimeout?: number
  /**
   * Maximum time in milliseconds to wait for the command to complete.
   * @default Infinity
   */
  completedTimeout?: number
  /**
   * Optional command to run during teardown (e.g., to stop a server).
   */
  teardown?: string
  /**
   * Optional environment variables to set for the process spawned by this command.
   * Overrides environment variables inherited from the parent process & task config.
   */
  env?: Record<string, string>
  /**
   * Optional configuration for enabling task-level caching.
   *
   * When provided, builderman will:
   * - Compute a snapshot of the configured `input` and `output` paths
   *   based on their file metadata (mtime and size).
   * - Store this snapshot under a `.builderman` directory in the current
   *   process working directory.
   * - On subsequent runs, compare the current snapshot to the stored one.
   *   If both the inputs and outputs are unchanged, the task will be
   *   **skipped** for the current mode instead of spawning the command.
   *
   * This is useful for build-style tasks where you want to avoid re-running
   * expensive work when nothing in the inputs or outputs has changed.
   */
  cache?: CommandCacheConfig
}

export interface CommandConfigInternal extends CommandConfig {
  cache?: CommandCacheConfigInternal
  commandRefDependencies?: Array<{
    taskId: string
    command: string
  }>
}

export interface CommandsInternal extends Commands {
  [key: string]: CommandConfigInternal
}

/**
 * Configuration for task-level caching.
 */
export interface CommandCacheConfig {
  /**
   * Paths, artifacts, and/or input resolvers that represent the task's inputs.
   * These are typically source directories (e.g. "src") or files, artifacts from other tasks,
   * or input resolvers that expand high-level intents into concrete cache inputs.
   *
   * Paths may be absolute or relative to the task's `cwd`.
   * Artifacts can be mixed with paths for convenience - they will be separated internally.
   * Artifacts are created via `task.artifact("command")` and are tracked by unique identifiers
   * that change when the producing task's outputs change.
   * Input resolvers (e.g., `pnpm.workspacePackage()`) expand to include dependency information
   * in the cache key.
   */
  inputs?: (string | Artifact | InputResolver)[]

  /**
   * Paths that represent the task's outputs.
   * These are typically build output directories (e.g. "dist") or files.
   *
   * Paths may be absolute or relative to the task's `cwd`.
   * If omitted, caching only considers the configured inputs.
   */
  outputs?: string[]
}

export interface CommandCacheConfigInternal extends CommandCacheConfig {
  artifacts?: Artifact[]
  resolvers?: InputResolver[]
}
/**
 * A command can be either a simple string or a CommandConfig object.
 * When a string is provided, it's equivalent to `{ run: string }`.
 */
export type Command = string | CommandConfig

/**
 * A map of command names to their configurations.
 * Common command names include "dev", "build", "test", etc.
 * The command name is selected based on the pipeline's run configuration.
 * If a matching command is not found, the task is skipped.
 */
export interface Commands {
  [key: string]: Command
}

/**
 * Represents a reference to a specific command's outputs (artifact).
 * Created via `task.artifact("build")` to specify artifact-level dependencies.
 * When a task depends on an artifact, its cache key includes the fingerprint
 * of those artifacts. If the artifacts haven't changed, the consuming task
 * can be skipped even if the producing task ran.
 */
export interface Artifact {
  /**
   * The task that produces the artifacts.
   */
  readonly task: Task
  /**
   * The command name whose outputs should be consumed (e.g., "build").
   */
  readonly command: string
  /**
   * Internal marker to distinguish Artifact from Task.
   * @internal
   */
  readonly [$ARTIFACT_INTERNAL]: true
}

/**
 * Configuration for creating a task in the pipeline.
 */
export interface TaskConfig<T extends Commands = Commands> {
  /**
   * The name of the task. Used for logging and identification.
   */
  name: string
  /**
   * Map of command names to their configurations.
   * The pipeline will select a command based on the run configuration
   * (defaults to "dev" in development, "build" in production).
   */
  commands: T
  /**
   * Working directory for the task's commands.
   * Can be absolute or relative to the current working directory.
   * @default "."
   */
  cwd?: string
  /**
   * Optional array of tasks that this task depends on.
   * When a task dependency is declared, each command in this task automatically
   * depends on the command with the same name in the dependency task (if it exists).
   * For example, if this task has commands `{ dev, build }` and depends on a task
   * with commands `{ dev, build }`, then this task's `dev` command will depend on
   * the dependency's `dev` command, and this task's `build` command will depend on
   * the dependency's `build` command.
   */
  dependencies?: Task[]
  /**
   * Allows this task to be skipped even in strict mode.
   * Use this to explicitly mark tasks that are intentionally mode-specific.
   */
  allowSkip?: boolean
  /**
   * Optional environment variables to set for the process spawned by this task.
   * Overrides environment variables inherited from the parent process.
   */
  env?: Record<string, string>
}

interface TaskInternal extends TaskConfig {
  id: string
  cwd: string
  dependencies: Task[]
  env: Record<string, string>
  // If set, this task represents a nested pipeline created via pipeline.toTask()
  pipeline?: Pipeline
  commands: CommandsInternal
}

type InferCommandNamesWithCacheOutput<T extends Commands> = {
  [K in keyof T]: T[K] extends CommandConfig
    ? T[K]["cache"] extends CommandCacheConfig
      ? T[K]["cache"]["outputs"] extends string[]
        ? K
        : never
      : never
    : never
}[keyof T]

/**
 * A task to be executed in a pipeline. Tasks are created using the `task()` function.
 * Tasks can have dependencies on other tasks and define commands to execute in a specific mode.
 */
export interface Task<T extends Commands = any> {
  /**
   * The name of the task.
   */
  name: string
  /**
   * Creates an artifact reference for a specific command of this task.
   * Used to specify artifact-level dependencies: `dependencies: [lib.artifact("build")]`
   *
   * @param command - The command name whose outputs should be consumed (e.g., "build").
   * @returns An Artifact object that can be used in command dependencies.
   * @throws Error if the command doesn't exist, doesn't have cache configuration, or doesn't have outputs.
   */
  artifact(command: InferCommandNamesWithCacheOutput<T>): Artifact
  /**
   * Internal task data. This property is for internal use only.
   * @internal
   */
  [$TASK_INTERNAL]: TaskInternal
}

/**
 * Configuration options for running a pipeline.
 */
export interface PipelineRunConfig {
  /**
   * Provides a custom command for the pipeline.
   * @default process.env.NODE_ENV === "production" ? "build" : "dev"
   */
  command?: string

  /**
   * Optional environment variables to set for processes spawned by this pipeline.
   * Overrides environment variables inherited from the parent process.
   */
  env?: Record<string, string>
  /**
   * Provides a custom abort signal for the pipeline.
   * Aborting the signal will cause the pipeline to fail.
   */
  signal?: AbortSignal
  /**
   * Provides a custom spawn function for the pipeline.
   * @default import("node:child_process").spawn
   */
  spawn?: typeof import("node:child_process").spawn
  /**
   * If true, missing commands will cause the pipeline to fail.
   * Use this for CI/release pipelines where every task is expected to participate.
   */
  strict?: boolean
  /**
   * Maximum number of tasks that can run concurrently.
   * @default Infinity (no limit)
   */
  maxConcurrency?: number
  /**
   * Optional set of tasks to exclude from the graph.
   * Used by nested pipelines to exclude already-satisfied dependencies.
   * @internal
   */
  excludeTasks?: Set<Task>
  /**
   * Callback invoked when a task begins execution.
   * @param taskName The name of the task that started.
   * @param taskId The id of the task that started.
   */
  onTaskBegin?: (taskName: string, taskId: string) => void
  /**
   * Callback invoked when a task becomes ready (via readyWhen condition).
   * This is called when a task with a `readyWhen` function satisfies its condition.
   * @param taskName The name of the task that became ready.
   * @param taskId The id of the task that became ready.
   */
  onTaskReady?: (taskName: string, taskId: string) => void
  /**
   * Callback invoked when a task completes successfully.
   * @param taskName The name of the task that completed.
   * @param taskId The id of the task that completed.
   */
  onTaskComplete?: (taskName: string, taskId: string) => void
  /**
   * Callback invoked when a task is skipped (e.g., when a command doesn't exist for the current mode).
   * @param taskName The name of the task that was skipped.
   * @param taskId The id of the task that was skipped.
   * @param mode The command mode that was requested (e.g., "dev", "build").
   */
  onTaskSkipped?: (
    taskName: string,
    taskId: string,
    mode: string,
    reason: TaskSkippedReason
  ) => void
  /**
   * Callback invoked when a task's teardown command begins execution.
   * @param taskName The name of the task whose teardown is running.
   * @param taskId The id of the task whose teardown is running.
   */
  onTaskTeardown?: (taskName: string, taskId: string) => void
  /**
   * Callback invoked when a task's teardown command fails.
   * Note: Teardown failures do not cause the pipeline to fail.
   * @param taskName The name of the task whose teardown failed.
   * @param error The error that occurred during teardown.
   */
  onTaskTeardownError?: (taskName: string, taskId: string, error: Error) => void
}

export type TaskSkippedReason =
  | "command-not-found"
  | "cache-hit"
  | "inner-tasks-skipped"

/**
 * Configuration for converting a pipeline into a task.
 * This allows pipelines to be used as dependencies in other pipelines.
 */
export interface PipelineTaskConfig {
  /**
   * The name for the task that represents this pipeline.
   */
  name: string
  /**
   * Optional array of tasks that must complete before this pipeline task can start.
   * These are task-level dependencies for the synthetic pipeline task.
   */
  dependencies?: Task[]
  /**
   * Optional environment variables to set for the process spawned by this pipeline task.
   * Overrides environment variables inherited from the parent process.
   */
  env?: Record<string, string>
}

interface PipelineInternal {
  tasks: Task[]
}

/**
 * A pipeline manages the execution of tasks with dependency-based coordination.
 * Pipelines are created using the `pipeline()` function.
 */
export interface Pipeline {
  /**
   * Runs the pipeline, executing all tasks according to their dependencies.
   * Tasks with no dependencies start immediately, and tasks with dependencies
   * wait for their dependencies to complete before starting.
   * @param config Optional configuration for pipeline execution.
   * @returns A promise that resolves with a RunResult containing execution stats.
   *          The result will have `ok: false` if any task fails or the pipeline is aborted.
   */
  run(config?: PipelineRunConfig): Promise<RunResult>
  /**
   * Converts this pipeline into a task that can be used as a dependency
   * in another pipeline. This enables nested pipelines.
   * @param config Configuration for the task representation of this pipeline.
   * @returns A task that represents this pipeline.
   */
  toTask(config: PipelineTaskConfig): Task
  /**
   * Internal pipeline data. This property is for internal use only.
   * @internal
   */
  [$PIPELINE_INTERNAL]: PipelineInternal
}

export interface TaskNode {
  task: Task
  dependencies: Set<string> // ids of dependent tasks
  dependents: Set<string> // ids of tasks that depend on this one
}

export interface TaskGraph {
  nodes: Map<string, TaskNode>
  /**
   * Validates the graph for circular dependencies.
   * @throws Error if circular dependencies are detected
   */
  validate(): void
  /**
   * Simplifies the graph by removing transitive dependencies.
   * If A depends on B and B depends on C, then A->C is transitive and can be removed.
   */
  simplify(): void
}

/**
 * Status of a task in the pipeline.
 * - "pending": Task has not started yet
 * - "skipped": Task was skipped (e.g., no command for the current mode)
 * - "running": Task is currently executing
 * - "completed": Task completed successfully
 * - "failed": Task failed during execution
 * - "aborted": Task was aborted (e.g., due to pipeline cancellation)
 */
export type TaskStatus =
  | "pending"
  | "skipped"
  | "running"
  | "completed"
  | "failed"
  | "aborted"

/**
 * Statistics for a single task in the pipeline.
 */
export interface TaskStats {
  /**
   * Unique identifier for the task.
   */
  id: string
  /**
   * Human-readable name of the task.
   */
  name: string
  /**
   * Current status of the task.
   */
  status: TaskStatus
  /**
   * Command name that was executed (e.g., "dev", "build").
   * Only present if the task was executed or skipped (not if it's still pending).
   */
  command?: string
  /**
   * Timestamp (milliseconds since epoch) when the task started execution.
   * Only present if the task started running.
   */
  startedAt?: number
  /**
   * Timestamp (milliseconds since epoch) when the task finished execution.
   * Only present if the task completed, failed, was skipped, or was aborted.
   */
  finishedAt?: number
  /**
   * Duration of task execution in milliseconds.
   * Only present if the task has finished (completed, failed, skipped, or aborted).
   */
  durationMs?: number
  /**
   * Exit code of the task's process.
   * Only present if the task completed or failed.
   * Typically 0 for success, non-zero for failure.
   */
  exitCode?: number
  /**
   * Signal that terminated the task's process (e.g., "SIGTERM", "SIGKILL").
   * Only present if the task was terminated by a signal.
   */
  signal?: string
  /**
   * Error that occurred during task execution.
   * Only present if the task failed or was aborted.
   */
  error?: Error
  /**
   * Teardown command execution status.
   * Only present if the task had a teardown command configured.
   */
  teardown?: {
    /**
     * Status of the teardown command execution.
     * - "not-run": Teardown was registered but never executed (e.g., task failed before starting)
     * - "completed": Teardown executed successfully
     * - "failed": Teardown execution failed
     */
    status: "not-run" | "completed" | "failed"
    /**
     * Error that occurred during teardown execution.
     * Only present if teardown status is "failed".
     */
    error?: Error
  }
  /**
   * Array of task IDs that this task depends on.
   * These tasks must complete before this task can start.
   */
  dependencies: string[]
  /**
   * Array of task IDs that depend on this task.
   * These tasks cannot start until this task completes.
   */
  dependents: string[]
  /**
   * Cache-related information for this task.
   * Only present if the task has cache configuration.
   */
  cache?: {
    /**
     * Whether the cache was checked (regardless of hit/miss).
     * Always present when cache is configured.
     */
    checked: boolean
    /**
     * Path to the cache file used for this task.
     * Always present when cache is configured.
     */
    cacheFile: string
    /**
     * Input paths that were monitored for cache invalidation.
     * Always present when cache is configured.
     */
    inputs: string[]
    /**
     * Output paths that were monitored for cache invalidation.
     * Always present when cache is configured.
     */
    outputs: string[]
    /**
     * Whether the task was skipped due to a cache hit.
     * Only present when `checked` is `true`.
     */
    hit?: boolean
  }
  /**
   * Statistics for nested tasks when this task represents a pipeline
   * (created via pipeline.toTask()). Only present for pipeline-tasks.
   * Contains statistics for all tasks within the nested pipeline.
   */
  subtasks?: TaskStats[]
}

/**
 * Statistics for the entire pipeline execution.
 */
export interface PipelineStats {
  /**
   * Command name that was executed for this pipeline run (e.g., "dev", "build").
   */
  command: string
  /**
   * Timestamp (milliseconds since epoch) when the pipeline started.
   */
  startedAt: number
  /**
   * Timestamp (milliseconds since epoch) when the pipeline finished.
   */
  finishedAt: number
  /**
   * Total duration of pipeline execution in milliseconds.
   */
  durationMs: number
  /**
   * Overall status of the pipeline.
   * - "success": All tasks completed successfully
   * - "failed": One or more tasks failed
   * - "aborted": Pipeline was aborted (e.g., due to signal cancellation)
   */
  status: "success" | "failed" | "aborted"
  /**
   * Array of task statistics.
   * Contains statistics for all tasks in the pipeline, regardless of their status.
   */
  tasks: TaskStats[]
  /**
   * Summary of task execution counts.
   */
  summary: {
    /**
     * Total number of tasks in the pipeline.
     */
    total: number
    /**
     * Number of tasks that completed successfully.
     */
    completed: number
    /**
     * Number of tasks that failed.
     */
    failed: number
    /**
     * Number of tasks that were skipped.
     */
    skipped: number
    /**
     * Number of tasks that were still running when the pipeline ended.
     * This is useful when the pipeline was aborted - it indicates how many
     * tasks were in progress and had to be terminated.
     */
    running: number
  }
}

/**
 * Result of running a pipeline.
 * The pipeline never throws - it always returns a RunResult with detailed statistics.
 *
 * @example
 * ```ts
 * const result = await pipeline(tasks).run({ command: "dev" })
 *
 * if (!result.ok) {
 *   console.error("Pipeline failed:", result.error)
 * }
 *
 * console.log("Pipeline stats:", result.stats)
 * console.log(`Completed: ${result.stats.summary.completed}`)
 * console.log(`Failed: ${result.stats.summary.failed}`)
 * ```
 */
export type RunResult =
  | {
      /**
       * Indicates the pipeline completed successfully.
       * When true, `error` is always `null`.
       */
      ok: true
      /**
       * Always `null` when `ok` is `true`.
       */
      error: null
      /**
       * Pipeline execution statistics.
       */
      stats: PipelineStats
    }
  | {
      /**
       * Indicates the pipeline failed or was aborted.
       * When false, `error` contains the PipelineError that caused the failure.
       */
      ok: false
      /**
       * The error that caused the pipeline to fail.
       * Check `error.code` to determine the error type (e.g., `PipelineError.TaskFailed`).
       */
      error: PipelineError
      /**
       * Pipeline execution statistics.
       * Even when the pipeline fails, stats contain information about all tasks,
       * including which ones completed, failed, or were still running.
       */
      stats: PipelineStats
    }
