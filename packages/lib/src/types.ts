import type { $TASK_INTERNAL } from "./constants.js"

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

interface TaskInternal extends TaskConfig {
  id: number
  readyPromise: Promise<void>
  dependencies: Task[]
  isReady: (stdout: string) => boolean
  isComplete: () => boolean
  markReady: () => void
  markComplete: () => void
}

export interface Task {
  name: string
  [$TASK_INTERNAL]: TaskInternal
}

export interface PipelineRunConfig {
  onTaskError?: (taskName: string, error: Error) => void
  onTaskComplete?: (taskName: string) => void
  onPipelineError?: (error: Error) => void
  onPipelineComplete?: () => void
}

export interface Pipeline {
  run(config: PipelineRunConfig): Promise<void>
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
