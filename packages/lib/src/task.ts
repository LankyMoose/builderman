import { $TASK_INTERNAL } from "./constants.js"
import type { TaskConfig, Task } from "./types.js"

/**
 * Creates a task configuration.
 */
export function task(config: TaskConfig): Task {
  let resolveReady: (() => void) | null = null
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let isReady = false
  let isComplete = false

  return {
    name: config.name,
    readyOrComplete(): Promise<void> {
      return readyPromise
    },
    [$TASK_INTERNAL]: {
      ...config,
      dependsOn: config.dependsOn || [],
      isReady: () => isReady,
      isComplete: () => isComplete,
      markReady: () => {
        if (!isReady && resolveReady) {
          isReady = true
          resolveReady()
        }
      },
      markComplete: () => {
        if (!isComplete) {
          isComplete = true
          if (!isReady && resolveReady) {
            isReady = true
            resolveReady()
          }
        }
      },
    },
  }
}
