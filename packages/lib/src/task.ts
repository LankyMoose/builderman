import { $TASK_INTERNAL } from "./internal/constants.js"
import { validateTasks } from "./internal/util.js"
import type { TaskConfig, Task, Commands, CommandCacheConfig } from "./types.js"

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
  const {
    name,
    commands,
    cwd = ".",
    dependencies = [],
    env,
    allowSkip,
  } = config

  const dependenciesClone = [...dependencies]
  validateTasks(dependenciesClone)

  const commandsClone: Commands = Object.fromEntries(
    Object.entries(commands).map(([key, command]) => {
      if (typeof command === "string") {
        return [key, command]
      }

      const {
        run,
        readyWhen,
        readyTimeout,
        completedTimeout,
        teardown,
        env,
        cache,
      } = command

      let cacheConfig: CommandCacheConfig | undefined
      if (cache) {
        let inputs: string[] = []
        let outputs: string[] | undefined
        if (Array.isArray(cache.inputs)) {
          inputs = filterValidPaths(cache.inputs)
        }
        if (Array.isArray(cache.outputs)) {
          outputs = filterValidPaths(cache.outputs)
        }
        cacheConfig = {
          inputs,
          outputs,
        }
      }

      return [
        key,
        {
          run,
          readyWhen,
          readyTimeout,
          completedTimeout,
          teardown,
          env: { ...env },
          cache: cacheConfig,
        },
      ]
    })
  )

  return {
    name,
    [$TASK_INTERNAL]: {
      name,
      cwd,
      dependencies: dependenciesClone,
      env: { ...env },
      allowSkip,
      id: crypto.randomUUID(),
      commands: commandsClone,
    },
  }
}

function filterValidPaths(paths: string[]): string[] {
  return paths
    .filter((p) => typeof p === "string" && p.length > 0)
    .filter(Boolean)
}
