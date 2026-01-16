import { $TASK_INTERNAL } from "./constants.js"
import { validateTasks } from "./util.js"
import { pipeline } from "./pipeline.js"
import type { TaskConfig, Task, Pipeline } from "./types.js"

let taskId = 0

/**
 * Creates a task configuration.
 */
export function task(config: TaskConfig): Task {
  validateTasks(config.dependencies)

  const taskInstance: Task = {
    name: config.name,
    [$TASK_INTERNAL]: {
      ...config,
      id: taskId++,
      dependencies: [...(config.dependencies || [])],
    },
    andThen(nextConfig: Omit<TaskConfig, "dependencies">): Pipeline {
      // Create the next task with the current task as a dependency
      const nextTask = task({
        ...nextConfig,
        dependencies: [taskInstance],
      })
      // Return a pipeline containing both tasks
      return pipeline([taskInstance, nextTask])
    },
  }

  return taskInstance
}
