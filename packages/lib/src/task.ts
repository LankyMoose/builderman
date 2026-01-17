import { $TASK_INTERNAL } from "./constants.js"
import { validateTasks } from "./util.js"
import { pipeline } from "./pipeline.js"
import type { TaskConfig, Task, Pipeline } from "./types.js"

/**
 * Creates a task configuration.
 * @param config - The configuration for the task.
 * @returns A task instance.
 * @example
 * const build = task({ name: "build", commands: { build: "npm run build" }, cwd: "." })
 * const deploy = task({ name: "deploy", commands: { build: "npm run deploy" }, cwd: ".", dependencies: [build] })
 * await pipeline([build, deploy]).run()
 *
 * // alternatively, you can use the andThen method to chain tasks together:
 * const buildAndDeploy = task({ name: "build", commands: { build: "npm run build" }, cwd: "." })
 *   .andThen({ name: "deploy", commands: { build: "npm run deploy" }, cwd: "." })
 * await buildAndDeploy.run()
 */
export function task(config: TaskConfig): Task {
  validateTasks(config.dependencies)

  const taskInstance: Task = {
    name: config.name,
    [$TASK_INTERNAL]: {
      ...config,
      id: crypto.randomUUID(),
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
