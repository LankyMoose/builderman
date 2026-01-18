import { $TASK_INTERNAL } from "./constants.js"
import { validateTasks } from "./util.js"
import type { TaskConfig, Task } from "./types.js"

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
  const { name, commands, cwd = ".", dependencies = [], env } = config
  const dependenciesClone = [...dependencies]
  validateTasks(dependenciesClone)

  return {
    name,
    [$TASK_INTERNAL]: {
      name,
      cwd,
      dependencies: dependenciesClone,
      env: { ...env },
      id: crypto.randomUUID(),
      // deep clone commands to prevent external mutation
      commands: Object.fromEntries(
        Object.entries(commands).map(([key, command]) => {
          if (typeof command === "string") {
            return [key, command]
          }

          const { run, readyWhen, readyTimeout, teardown, env } = command
          return [
            key,
            { run, readyWhen, readyTimeout, teardown, env: { ...env } },
          ]
        })
      ),
    },
  }
}
