import { randomUUID } from "node:crypto"
import { $TASK_INTERNAL, $ARTIFACT_INTERNAL } from "./internal/constants.js"
import { validateTasks } from "./internal/util.js"
import type {
  TaskConfig,
  Task,
  Artifact,
  Commands,
  CommandCacheConfigInternal,
  CommandConfigInternal,
  CommandsInternal,
} from "./types.js"

/**
 * Creates a task configuration.
 * @param config - The configuration for the task.
 * @returns A task instance.
 * @example
 * const build = task({ name: "build", commands: { build: "npm run build" }, cwd: "." })
 * const deploy = task({ name: "deploy", commands: { build: "npm run deploy" }, cwd: ".", dependencies: [build] })
 * await pipeline([build, deploy]).run()
 */
/**
 * Checks if a value is an Artifact.
 */
function isArtifact(value: unknown): value is Artifact {
  return (
    typeof value === "object" &&
    value !== null &&
    $ARTIFACT_INTERNAL in value &&
    value[$ARTIFACT_INTERNAL] === true
  )
}

/**
 * Checks if a value is a Task.
 */
function isTask(value: Task | Artifact): value is Task {
  return (
    typeof value === "object" &&
    value !== null &&
    $TASK_INTERNAL in value &&
    !($ARTIFACT_INTERNAL in value)
  )
}

export function task<T extends Commands = Commands>(
  config: TaskConfig<T>
): Task<T> {
  const {
    name,
    commands,
    cwd = ".",
    dependencies = [],
    env,
    allowSkip,
  } = config

  const taskId = randomUUID()

  // Validate task dependencies
  validateTasks(dependencies)

  // We'll create the task object first (with a placeholder) so we can reference it
  // in command() and artifact() methods
  let taskObject: Task<T> | null = null

  const commandsClone: CommandsInternal = Object.fromEntries(
    Object.entries(commands).map(([key, command]) => {
      // If command is a string and we have task-level dependencies, we'll convert it
      // to a CommandConfig later when processing task dependencies
      if (typeof command === "string") {
        return [key, { run: command }]
      }

      const {
        run,
        dependencies: commandDependencies = [],
        readyWhen,
        readyTimeout,
        completedTimeout,
        teardown,
        env: commandEnv,
        cache,
      } = command

      // Process command-level dependencies (only Tasks now, no Artifacts)
      const commandRefDependencies: CommandConfigInternal["commandRefDependencies"] =
        []

      for (const dep of commandDependencies) {
        if (isTask(dep)) {
          // If it's a Task, automatically use the same command name
          commandRefDependencies.push({
            taskId: dep[$TASK_INTERNAL].id,
            command: key, // Use the current command name
          })
        } else {
          // This shouldn't happen since dependencies is now Task[] only
          throw new Error(
            `Invalid dependency type. Dependencies can only be Task objects.`
          )
        }
      }

      let cacheConfig: CommandCacheConfigInternal | undefined
      if (cache) {
        const inputs: string[] = []
        let artifacts: Artifact[] = []
        let outputs: string[] | undefined

        // Process inputs - separate artifacts from file paths
        if (Array.isArray(cache.inputs)) {
          for (const item of cache.inputs) {
            // Check if item is an artifact (has $ARTIFACT_INTERNAL property)
            if (isArtifact(item)) {
              artifacts.push(item)
            } else if (typeof item === "string" && item.length > 0) {
              inputs.push(item)
            } else {
              throw new Error("Invalid item in cache.inputs.")
            }
          }
        }

        // Validate all artifacts (extracted from inputs)
        for (const artifact of artifacts) {
          // Verify artifact has cache config with outputs
          const artifactTask = artifact.task
          const artifactCommand = artifact.command
          const artifactCommands = artifactTask[$TASK_INTERNAL].commands
          const artifactCommandConfig = artifactCommands[artifactCommand]
          if (!artifactCommandConfig) {
            throw new Error(
              `Artifact references non-existent command "${artifactCommand}" in task "${artifactTask.name}"`
            )
          }
          const artifactCacheConfig =
            typeof artifactCommandConfig === "string"
              ? undefined
              : artifactCommandConfig.cache
          if (
            !artifactCacheConfig ||
            !artifactCacheConfig.outputs ||
            artifactCacheConfig.outputs.length === 0
          ) {
            throw new Error(
              `Artifact from task "${artifactTask.name}" command "${artifactCommand}" does not have cache.outputs defined. ` +
                `Artifacts require cache.outputs to track changes.`
            )
          }
        }
        if (Array.isArray(cache.outputs)) {
          outputs = filterValidPaths(cache.outputs)
        }
        // After processing, inputs only contains strings (artifacts have been separated)
        // Store artifacts internally even though they're not in the public API
        cacheConfig = {
          inputs: inputs.length > 0 ? inputs : undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          outputs,
        }
      }

      // Store command dependencies in the command config
      // We'll need to access these during graph building
      const commandConfig: CommandConfigInternal = {
        run,
        readyWhen,
        readyTimeout,
        completedTimeout,
        teardown,
        env: { ...commandEnv },
        cache: cacheConfig,
        dependencies: commandDependencies,
        commandRefDependencies,
      }

      return [key, commandConfig]
    })
  )

  // Process task-level dependencies: automatically add command-level dependencies
  // for matching command names
  for (const depTask of dependencies) {
    const depCommands = depTask[$TASK_INTERNAL].commands
    const depCommandNames = Object.keys(depCommands)

    // For each command in this task, check if the dependency has a matching command
    for (const [commandName, commandConfig] of Object.entries(commandsClone)) {
      if (depCommandNames.includes(commandName)) {
        // The dependency has a command with the same name - add the task directly
        // (it will be converted to a CommandRef during processing)

        if (typeof commandConfig === "string") {
          // Convert string command to CommandConfig to add dependencies
          const newCommandConfig: CommandConfigInternal = {
            run: commandConfig,
            dependencies: [depTask], // Add Task directly
            commandRefDependencies: [
              {
                taskId: depTask[$TASK_INTERNAL].id,
                command: commandName,
              },
            ],
          }

          commandsClone[commandName] = newCommandConfig
        } else {
          // Add to the command's dependencies array
          const existingDeps = commandConfig.dependencies || []
          commandConfig.dependencies = [...existingDeps, depTask] // Add Task directly
          commandConfig.commandRefDependencies = [
            ...(commandConfig.commandRefDependencies || []),
            {
              taskId: depTask[$TASK_INTERNAL].id,
              command: commandName,
            },
          ]
        }
      }
    }
  }

  taskObject = {
    name,
    artifact(command: any): Artifact {
      const commandConfig = commandsClone[command]
      if (!commandConfig) {
        throw new Error(`Task "${name}" does not have a command "${command}"`)
      }

      // Check if command has cache configuration
      const cacheConfig =
        typeof commandConfig === "string" ? undefined : commandConfig.cache
      if (!cacheConfig) {
        throw new Error(
          `Task "${name}" command "${command}" does not have cache configuration. ` +
            `Artifact dependencies require cache.outputs to be defined.`
        )
      }

      if (!cacheConfig.outputs || cacheConfig.outputs.length === 0) {
        throw new Error(
          `Task "${name}" command "${command}" does not have cache.outputs defined. ` +
            `Artifact dependencies require cache.outputs to track artifact changes.`
        )
      }

      return {
        task: taskObject!,
        command,
        [$ARTIFACT_INTERNAL]: true as const,
      }
    },
    [$TASK_INTERNAL]: {
      name,
      cwd,
      env: { ...env },
      allowSkip,
      id: taskId,
      commands: commandsClone,
    },
  }

  return taskObject
}

function filterValidPaths(paths: string[]): string[] {
  return paths
    .filter((p) => typeof p === "string" && p.length > 0)
    .filter(Boolean)
}
