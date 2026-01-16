import type { $TASK_INTERNAL } from "./constants.js"
import { PipelineError } from "./pipeline.js"

export interface CommandConfig {
  run: string
  readyWhen?: (stdout: string) => boolean
  readyTimeout?: number
  teardown?: string
}

export type Command = string | CommandConfig

export interface Commands {
  [key: string]: Command
}

export interface TaskConfig {
  name: string
  commands: Commands
  cwd: string
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

export interface Task {
  name: string
  [$TASK_INTERNAL]: TaskInternal
  andThen(config: Omit<TaskConfig, "dependencies">): Pipeline
}

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
  onTaskBegin?: (taskName: string) => void
  onTaskComplete?: (taskName: string) => void
  onTaskSkipped?: (taskName: string, mode: string) => void
  onTaskTeardown?: (taskName: string) => void
  onTaskTeardownError?: (taskName: string, error: Error) => void
  onPipelineError?: (error: PipelineError) => void
  onPipelineComplete?: () => void
}

export interface PipelineTaskConfig {
  name: string
  dependencies?: Task[]
}

export interface Pipeline {
  run(config?: PipelineRunConfig): Promise<void>
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
