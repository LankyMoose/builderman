import { $TASK_INTERNAL } from "./constants.js"
import { validateTasks } from "./util.js"
import type { TaskConfig, Task, Commands } from "./types.js"

/**
 * Creates a task configuration.
 * @param config - The configuration for the task.
 * @returns A task instance.
 * @example
 * const build = task({ name: "build", commands: { build: "npm run build" }, cwd: "." })
 * const deploy = task({ name: "deploy", commands: { build: "npm run deploy" }, cwd: ".", dependencies: [build] })
 * await pipeline([build, deploy]).run()
 */
export function task(config: TaskConfig): Task {
  validateTasks(config.dependencies)

  const taskInstance: Task = {
    name: config.name,
    [$TASK_INTERNAL]: {
      ...config,
      id: crypto.randomUUID(),
      commands: Object.fromEntries(
        Object.entries(config.commands).map(([key, value]) => [
          key,
          typeof value === "string" ? value : { ...value },
        ])
      ),
      dependencies: [...(config.dependencies || [])],
    },
  }

  return taskInstance
}
