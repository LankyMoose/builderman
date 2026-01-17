import type { $TASK_INTERNAL } from "./constants.js"
import { PipelineError } from "./pipeline-error.js"

/**
 * Configuration for a command to be executed as part of a task.
 */
export interface CommandConfig {
  /**
   * The command string to execute (e.g., "npm run dev" or "node server.js").
   */
  run: string
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
   * Optional command to run during teardown (e.g., to stop a server).
   */
  teardown?: string
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
 * Configuration for creating a task in the pipeline.
 */
export interface TaskConfig {
  /**
   * The name of the task. Used for logging and identification.
   */
  name: string
  /**
   * Map of command names to their configurations.
   * The pipeline will select a command based on the run configuration
   * (defaults to "dev" in development, "build" in production).
   */
  commands: Commands
  /**
   * Working directory for the task's commands.
   * Can be absolute or relative to the current working directory.
   */
  cwd: string
  /**
   * Optional array of tasks that must complete before this task can start.
   * Dependencies are executed in parallel when possible.
   */
  dependencies?: Task[]
  /**
   * Allows this task to be skipped even in strict mode.
   * Use this to explicitly mark tasks that are intentionally mode-specific.
   */
  allowSkip?: boolean
}

interface TaskInternal extends TaskConfig {
  id: number
  dependencies: Task[]
  pipeline?: Pipeline // If set, this task represents a nested pipeline
}

/**
 * A task to be executed in a pipeline. Tasks are created using the `task()` function.
 * Tasks can have dependencies on other tasks and define commands to execute in a specific mode.
 */
export interface Task {
  /**
   * The name of the task.
   */
  name: string
  /**
   * Internal task data. This property is for internal use only.
   * @internal
   */
  [$TASK_INTERNAL]: TaskInternal
  /**
   * Creates a new pipeline that starts after this task completes.
   * This allows for chaining tasks together.
   * @param config Task configuration for the next task in the chain.
   * @returns A new pipeline starting with the configured task.
   */
  andThen(config: Omit<TaskConfig, "dependencies">): Pipeline
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
   * Callback invoked when a task begins execution.
   * @param taskName The name of the task that started.
   */
  onTaskBegin?: (taskName: string) => void
  /**
   * Callback invoked when a task completes successfully.
   * @param taskName The name of the task that completed.
   */
  onTaskComplete?: (taskName: string) => void
  /**
   * Callback invoked when a task is skipped (e.g., when a command doesn't exist for the current mode).
   * @param taskName The name of the task that was skipped.
   * @param mode The command mode that was requested (e.g., "dev", "build").
   */
  onTaskSkipped?: (taskName: string, mode: string) => void
  /**
   * Callback invoked when a task's teardown command begins execution.
   * @param taskName The name of the task whose teardown is running.
   */
  onTaskTeardown?: (taskName: string) => void
  /**
   * Callback invoked when a task's teardown command fails.
   * Note: Teardown failures do not cause the pipeline to fail.
   * @param taskName The name of the task whose teardown failed.
   * @param error The error that occurred during teardown.
   */
  onTaskTeardownError?: (taskName: string, error: Error) => void
  /**
   * Callback invoked when the pipeline encounters an error and fails.
   * @param error The PipelineError that caused the pipeline to fail.
   */
  onPipelineError?: (error: PipelineError) => void
  /**
   * Callback invoked when the pipeline completes successfully.
   * This is called after all tasks have completed and all teardowns have finished.
   */
  onPipelineComplete?: () => void
}

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
   */
  dependencies?: Task[]
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
   * @returns A promise that resolves when all tasks complete successfully,
   *          or rejects if any task fails or the pipeline is aborted.
   */
  run(config?: PipelineRunConfig): Promise<void>
  /**
   * Converts this pipeline into a task that can be used as a dependency
   * in another pipeline. This enables nested pipelines.
   * @param config Configuration for the task representation of this pipeline.
   * @returns A task that represents this pipeline.
   */
  toTask(config: PipelineTaskConfig): Task
}

export interface TaskNode {
  task: Task
  dependencies: Set<number> // ids of dependent tasks
  dependents: Set<number> // ids of tasks that depend on this one
}

export interface TaskGraph {
  nodes: Map<number, TaskNode>
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
