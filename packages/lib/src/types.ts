import type { $TASK_INTERNAL } from "./constants.js"

export interface Commands {
  dev: string
  build: string
}

export interface TaskConfig {
  name: string
  commands: Commands
  cwd: string
  readyOn?: (output: string) => boolean
  dependsOn?: Dependency[]
}

export type Dependency = Promise<void> | (() => Promise<void>)

interface TaskInternal extends TaskConfig {
  dependsOn: Dependency[]
  isReady: () => boolean
  isComplete: () => boolean
  markReady: () => void
  markComplete: () => void
}

export interface Task {
  name: string
  readyOrComplete(): Promise<void>
  [$TASK_INTERNAL]: TaskInternal
}

export interface Pipeline {
  run(): Promise<void>
}
