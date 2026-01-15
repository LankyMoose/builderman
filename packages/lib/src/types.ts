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
