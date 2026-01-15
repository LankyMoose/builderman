import { $TASK_INTERNAL } from "./constants.js"
import type { TaskConfig, Task } from "./types.js"

let taskId = 0

/**
 * Creates a task configuration.
 */
export function task(config: TaskConfig): Task {
  return {
    name: config.name,
    [$TASK_INTERNAL]: {
      ...config,
      id: taskId++,
      dependencies: [...(config.dependencies || [])],
      shouldStdoutMarkReady: config.isReady,
    },
  }
}
