import type { $TASK_INTERNAL } from "./constants.js"
import { PipelineError } from "./pipeline.js"

export interface Commands {
  dev: string
  build: string
}

export interface TaskConfig {
  name: string
  commands: Commands
  cwd: string
  isReady?: (stdout: string) => boolean
  dependencies?: Task[]
}

interface TaskInternal extends Omit<TaskConfig, "isReady"> {
  id: number
  dependencies: Task[]
  shouldStdoutMarkReady?: (stdout: string) => boolean
  pipeline?: Pipeline // If set, this task represents a nested pipeline
}

export interface Task {
  name: string
  [$TASK_INTERNAL]: TaskInternal
  andThen(config: Omit<TaskConfig, "dependencies">): Pipeline
}

export interface PipelineRunConfig {
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
  onTaskBegin?: (taskName: string) => void
  onTaskComplete?: (taskName: string) => void
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
