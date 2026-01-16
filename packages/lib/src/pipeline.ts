import { spawn, ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { createScheduler, SchedulerInput } from "./scheduler.js"
import { task } from "./task.js"
import { validateTasks } from "./util.js"
import type { Pipeline, Task, PipelineTaskConfig, TaskGraph } from "./types.js"

// Module-level cache for pipeline-to-task conversions
// Key: Pipeline, Value: Map of name -> Task
const pipelineTaskCache = new WeakMap<Pipeline, Map<string, Task>>()

// Store tasks for each pipeline (for nested pipeline skip tracking)
const pipelineTasksCache = new WeakMap<Pipeline, Task[]>()

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 */
export function pipeline(tasks: Task[]): Pipeline {
  const graph = createTaskGraph(tasks)
  graph.validate()
  graph.simplify()

  const pipelineImpl: Pipeline = {
    toTask(config: PipelineTaskConfig): Task {
      validateTasks(config.dependencies)

      const syntheticTask = task({
        name: config.name,
        commands: {},
        cwd: ".", // Dummy cwd
        dependencies: [...(config.dependencies || [])],
      })

      // Mark this task as a pipeline task
      syntheticTask[$TASK_INTERNAL].pipeline = pipelineImpl

      // Cache this conversion
      let cache = pipelineTaskCache.get(pipelineImpl)
      if (!cache) {
        cache = new Map()
        pipelineTaskCache.set(pipelineImpl, cache)
      }
      cache.set(config.name, syntheticTask)

      return syntheticTask
    },

    async run(config): Promise<void> {
      const spawnFn = config?.spawn ?? spawn
      const signal = config?.signal
      const runningTasks = new Map<number, ChildProcess>()
      const runningPipelines = new Map<number, { stop: () => void }>()
      const teardownCommands = new Map<
        number,
        { command: string; cwd: string; taskName: string }
      >()
      let failed = false

      // Check if signal is already aborted
      if (signal?.aborted) {
        throw new PipelineError("Aborted", PipelineError.Aborted)
      }

      const scheduler = createScheduler(graph)

      let completionResolver: (() => void) | null = null
      let completionRejector: ((error: PipelineError) => void) | null = null
      const completionPromise = new Promise<void>((resolve, reject) => {
        completionResolver = resolve
        completionRejector = reject
      })

      const executeTeardown = (taskId: number): Promise<void> => {
        const teardown = teardownCommands.get(taskId)
        if (!teardown) return Promise.resolve()

        // Remove from map so it doesn't run again
        teardownCommands.delete(taskId)

        config?.onTaskTeardown?.(teardown.taskName)

        return new Promise<void>((resolve) => {
          try {
            const teardownProcess = spawnFn(teardown.command, {
              cwd: teardown.cwd,
              stdio: "inherit",
              shell: true,
            })

            let resolved = false
            const resolveOnce = () => {
              if (!resolved) {
                resolved = true
                resolve()
              }
            }

            teardownProcess.on("error", (error) => {
              const teardownError = new Error(
                `[${teardown.taskName}] Teardown failed: ${error.message}`
              )
              config?.onTaskTeardownError?.(teardown.taskName, teardownError)
              resolveOnce()
            })

            teardownProcess.on("exit", (code) => {
              if (code !== 0) {
                const teardownError = new Error(
                  `[${teardown.taskName}] Teardown failed with exit code ${
                    code ?? 1
                  }`
                )
                config?.onTaskTeardownError?.(teardown.taskName, teardownError)
              }
              resolveOnce()
            })
          } catch (error: any) {
            const teardownError = new Error(
              `[${teardown.taskName}] Teardown failed to start: ${error.message}`
            )
            config?.onTaskTeardownError?.(teardown.taskName, teardownError)
            resolve()
          }
        })
      }

      const executeAllTeardowns = async (): Promise<void> => {
        // Execute teardowns in reverse dependency order
        // Tasks with dependents should be torn down before their dependencies
        const taskIdsWithTeardown = Array.from(teardownCommands.keys())

        if (taskIdsWithTeardown.length === 0) {
          return
        }

        // Calculate reverse topological order
        // Tasks that have dependents should be torn down first
        const teardownOrder = getReverseDependencyOrder(
          taskIdsWithTeardown,
          graph
        )

        // Execute teardowns sequentially in reverse dependency order
        // This ensures dependents are torn down before their dependencies
        for (const taskId of teardownOrder) {
          await executeTeardown(taskId)
        }
      }

      const getReverseDependencyOrder = (
        taskIds: number[],
        graph: TaskGraph
      ): number[] => {
        // Create a set for quick lookup
        const taskIdSet = new Set(taskIds)

        // For reverse dependency order, we want to tear down dependents before dependencies
        // If api depends on db, we want: api first, then db
        // This is the reverse of normal execution order

        // Count how many dependencies each task has (within the teardown set)
        const dependencyCount = new Map<number, number>()
        for (const taskId of taskIds) {
          const node = graph.nodes.get(taskId)
          if (node) {
            let count = 0
            for (const depId of node.dependencies) {
              if (taskIdSet.has(depId)) {
                count++
              }
            }
            dependencyCount.set(taskId, count)
          }
        }

        // Build result in reverse order
        // Start with tasks that have no dependencies (leaf nodes) - these go LAST
        const result: number[] = []
        const visited = new Set<number>()
        const queue: number[] = []

        // Find leaf nodes (tasks with no dependencies in teardown set)
        for (const taskId of taskIds) {
          if (dependencyCount.get(taskId) === 0) {
            queue.push(taskId)
          }
        }

        // Process in reverse topological order
        while (queue.length > 0) {
          const taskId = queue.shift()!
          if (visited.has(taskId)) continue
          visited.add(taskId)

          // Add to front (so we get reverse order: dependents before dependencies)
          result.unshift(taskId)

          // Find tasks that depend on this one (dependents)
          const node = graph.nodes.get(taskId)
          if (node) {
            for (const dependentId of node.dependents) {
              if (taskIdSet.has(dependentId) && !visited.has(dependentId)) {
                const currentCount = dependencyCount.get(dependentId) ?? 0
                const newCount = currentCount - 1
                dependencyCount.set(dependentId, newCount)
                // When a dependent has no more dependencies to wait for, add it to queue
                if (newCount === 0) {
                  queue.push(dependentId)
                }
              }
            }
          }
        }

        // Add any remaining tasks (shouldn't happen in a valid graph, but handle it)
        for (const taskId of taskIds) {
          if (!visited.has(taskId)) {
            result.unshift(taskId)
          }
        }

        return result
      }

      const failPipeline = async (error: PipelineError) => {
        if (failed) return
        failed = true

        for (const child of runningTasks.values()) {
          try {
            child.kill("SIGTERM")
          } catch {}
        }

        // Stop nested pipelines
        for (const { stop } of runningPipelines.values()) {
          try {
            stop()
          } catch {}
        }

        // Execute all teardown commands and wait for them to complete
        // Even if teardowns fail, we still want to reject the pipeline
        try {
          await executeAllTeardowns()
        } catch (teardownError) {
          // Teardown errors are already reported via onTaskTeardownError
          // We continue to reject the pipeline with the original error
        }

        config?.onPipelineError?.(error)
        completionRejector?.(error)
      }

      const startTask = (task: Task) => {
        // Check if signal is aborted before starting new tasks
        if (signal?.aborted) {
          failPipeline(
            new PipelineError("Aborted", PipelineError.InvalidSignal)
          )
          return
        }

        const {
          name: taskName,
          [$TASK_INTERNAL]: { id: taskId, pipeline: nestedPipeline },
        } = task

        if (runningTasks.has(taskId)) return

        // Handle pipeline tasks
        if (nestedPipeline) {
          // Track nested pipeline state for skip behavior
          let nestedSkippedCount = 0
          let nestedCompletedCount = 0

          // Get total tasks from nested pipeline
          const nestedTasks = pipelineTasksCache.get(nestedPipeline)
          const nestedTotalTasks = nestedTasks
            ? createTaskGraph(nestedTasks).nodes.size
            : 0

          // Mark as ready immediately (pipeline entry nodes will handle their own ready state)
          advanceScheduler({ type: "ready", taskId })
          config?.onTaskBegin?.(taskName)

          // Create an abort controller to stop the nested pipeline if needed
          let pipelineStopped = false
          const stopPipeline = () => {
            pipelineStopped = true
            // The nested pipeline will continue running, but we've marked it as stopped
            // In a more sophisticated implementation, we could propagate stop signals
          }

          runningPipelines.set(taskId, { stop: stopPipeline })

          // Run the nested pipeline with signal propagation
          nestedPipeline
            .run({
              spawn: spawnFn,
              command: config?.command,
              strict: config?.strict,
              signal, // Pass signal to nested pipeline
              onTaskBegin: (nestedTaskName) => {
                if (pipelineStopped) return
                config?.onTaskBegin?.(`${taskName}:${nestedTaskName}`)
              },
              onTaskComplete: (nestedTaskName) => {
                if (pipelineStopped) return
                nestedCompletedCount++
                config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`)
              },
              onTaskSkipped: (nestedTaskName, mode) => {
                if (pipelineStopped) return
                nestedSkippedCount++
                config?.onTaskSkipped?.(`${taskName}:${nestedTaskName}`, mode)
              },
              onPipelineError: (error) => {
                if (pipelineStopped) return
                runningPipelines.delete(taskId)
                // error is already a PipelineError
                failPipeline(error)
              },
              onPipelineComplete: () => {
                if (pipelineStopped) return
                runningPipelines.delete(taskId)

                // Determine nested pipeline result based on skip behavior:
                // - If all inner tasks are skipped → outer task is skipped
                // - If some run, some skip → outer task is completed
                // - If any fail → outer task fails (handled in onPipelineError)
                const commandName =
                  config?.command ?? process.env.NODE_ENV === "production"
                    ? "build"
                    : "dev"

                if (
                  nestedSkippedCount === nestedTotalTasks &&
                  nestedTotalTasks > 0
                ) {
                  // All tasks were skipped
                  console.log(
                    `[${taskName}] skipped (all nested tasks skipped)`
                  )
                  config?.onTaskSkipped?.(taskName, commandName)
                  setImmediate(() => {
                    advanceScheduler({ type: "skip", taskId })
                  })
                } else {
                  // Some tasks ran (and completed successfully)
                  config?.onTaskComplete?.(taskName)
                  advanceScheduler({ type: "complete", taskId })
                }
              },
            })
            .catch((error) => {
              if (pipelineStopped) return
              runningPipelines.delete(taskId)
              failPipeline(error)
            })

          return
        }

        // Regular task execution
        const commandName =
          config?.command ?? process.env.NODE_ENV === "production"
            ? "build"
            : "dev"
        const commandConfig = task[$TASK_INTERNAL].commands[commandName]

        // Check if command exists
        if (commandConfig === undefined) {
          const allowSkip = task[$TASK_INTERNAL].allowSkip ?? false
          const strict = config?.strict ?? false

          // If strict mode and not explicitly allowed to skip, fail
          if (strict && !allowSkip) {
            failPipeline(
              new PipelineError(
                `[${taskName}] No command for "${commandName}" and strict mode is enabled`,
                PipelineError.TaskFailed
              )
            )
            return
          }

          // Skip the task
          console.log(`[${taskName}] skipped "${commandName}"`)
          config?.onTaskSkipped?.(taskName, commandName)
          // Mark as skipped - this satisfies dependencies and unblocks dependents
          // Use setImmediate to ensure scheduler is at idle yield before receiving skip
          setImmediate(() => {
            advanceScheduler({ type: "skip", taskId })
          })
          return
        }

        const command =
          typeof commandConfig === "string" ? commandConfig : commandConfig.run
        const readyWhen =
          typeof commandConfig === "string"
            ? undefined
            : commandConfig.readyWhen
        const teardown =
          typeof commandConfig === "string" ? undefined : commandConfig.teardown

        const { cwd } = task[$TASK_INTERNAL]

        const taskCwd = path.isAbsolute(cwd)
          ? cwd
          : path.resolve(process.cwd(), cwd)

        if (!fs.existsSync(taskCwd)) {
          failPipeline(
            new PipelineError(
              `[${taskName}] Working directory does not exist: ${taskCwd}`,
              PipelineError.InvalidTask
            )
          )
          return
        }

        const accumulatedPath = [
          path.join(taskCwd, "node_modules", ".bin"),
          path.join(process.cwd(), "node_modules", ".bin"),
          process.env.PATH,
        ]
          .filter(Boolean)
          .join(process.platform === "win32" ? ";" : ":")

        const env = {
          ...process.env,
          PATH: accumulatedPath,
          Path: accumulatedPath,
        }

        const child = spawnFn(command, {
          cwd: taskCwd,
          stdio: ["inherit", "pipe", "pipe"],
          shell: true,
          env,
        })

        runningTasks.set(taskId, child)

        // Store teardown command if provided
        if (teardown) {
          teardownCommands.set(taskId, {
            command: teardown,
            cwd: taskCwd,
            taskName,
          })
        }

        config?.onTaskBegin?.(taskName)

        let didMarkReady = false
        if (!readyWhen) {
          advanceScheduler({ type: "ready", taskId })
          didMarkReady = true
        }

        let output = ""

        child.stdout?.on("data", (buf) => {
          // Check if signal is aborted before processing stdout
          if (signal?.aborted) {
            return
          }

          const chunk = buf.toString()
          output += chunk
          process.stdout.write(chunk)

          if (!didMarkReady && readyWhen && readyWhen(output)) {
            advanceScheduler({ type: "ready", taskId })
            didMarkReady = true
          }
        })

        child.stderr?.on("data", (buf) => {
          process.stderr.write(buf)
        })

        child.on("error", (error) => {
          // Task failed before entering running state, so don't execute teardown
          // Remove teardown from map since it was never actually running
          teardownCommands.delete(taskId)

          failPipeline(
            new PipelineError(
              `[${taskName}] Failed to start: ${error.message}`,
              PipelineError.TaskFailed
            )
          )
        })

        child.on("exit", (code) => {
          runningTasks.delete(taskId)

          // Don't execute teardown immediately - it will be executed in reverse dependency order
          // when the pipeline completes or fails

          if (code !== 0) {
            failPipeline(
              new PipelineError(
                `[${taskName}] Task failed with exit code ${code ?? 1}`,
                PipelineError.TaskFailed
              )
            )
            return
          }

          config?.onTaskComplete?.(taskName)

          // 🔑 Notify scheduler and drain newly runnable tasks
          advanceScheduler({ type: "complete", taskId })
        })
      }

      const advanceScheduler = (input?: SchedulerInput) => {
        // Check if signal is aborted before advancing scheduler
        if (signal?.aborted) {
          failPipeline(new PipelineError("Aborted", PipelineError.Aborted))
          return
        }

        let result = input ? scheduler.next(input) : scheduler.next()

        // If we passed skip/complete input and got "idle", the generator processed it
        // but returned the old yield. Call next() again to get the result after processing.
        if (
          input &&
          (input.type === "skip" || input.type === "complete") &&
          result.value?.type === "idle"
        ) {
          result = scheduler.next()
        }

        while (true) {
          // Check signal again in the loop
          if (signal?.aborted) {
            failPipeline(new PipelineError("Aborted", PipelineError.Aborted))
            return
          }

          const event = result.value
          const isFinished = result.done && result.value.type === "done"

          if (isFinished) {
            config?.onPipelineComplete?.()
            completionResolver?.()
            return
          }

          if (event.type === "run") {
            startTask(graph.nodes.get(event.taskId)!.task)
            result = scheduler.next()
            continue
          }

          if (event.type === "idle") {
            return
          }
        }
      }

      // Handle termination signals
      const processTerminationListenerCleanups = [
        "SIGINT",
        "SIGTERM",
        "SIGQUIT",
        "SIGBREAK",
      ].map((sig) => {
        const handleSignal = () => {
          failPipeline(
            new PipelineError(
              `Received ${sig}`,
              PipelineError.ProcessTerminated
            )
          )
        }
        process.once(sig, handleSignal)
        return () => {
          process.removeListener(sig, handleSignal)
        }
      })

      // Handle abort signal if provided
      let signalCleanup: (() => void) | null = null
      if (signal) {
        const handleAbort = () => {
          failPipeline(new PipelineError("Aborted", PipelineError.Aborted))
        }
        signal.addEventListener("abort", handleAbort)
        signalCleanup = () => {
          signal.removeEventListener("abort", handleAbort)
        }
      }

      // 🚀 Kick off initial runnable tasks
      advanceScheduler()

      await completionPromise
        .then(async () => {
          // Pipeline completed successfully - execute any remaining teardowns
          // (for tasks that completed successfully) and wait for them to complete
          // Even if teardowns fail, the pipeline still resolves successfully
          // (teardown errors are reported via onTaskTeardownError)
          try {
            await executeAllTeardowns()
          } catch (teardownError) {
            // Teardown errors are already reported via onTaskTeardownError
            // The pipeline still resolves successfully
          }
        })
        .finally(() => {
          processTerminationListenerCleanups.forEach((cleanup) => cleanup())
          signalCleanup?.()
        })
    },
  }

  // Store tasks for nested pipeline skip tracking
  pipelineTasksCache.set(pipelineImpl, tasks)

  return pipelineImpl
}

type PipelineErrorCode =
  | typeof PipelineError.Aborted
  | typeof PipelineError.ProcessTerminated
  | typeof PipelineError.TaskFailed
  | typeof PipelineError.InvalidSignal
  | typeof PipelineError.InvalidTask

export class PipelineError extends Error {
  readonly code: PipelineErrorCode
  readonly taskName?: string
  constructor(message: string, code: PipelineErrorCode, taskName?: string) {
    super(message)
    this.name = "PipelineError"
    this.code = code
    this.taskName = taskName
  }

  static Aborted = 0 as const
  static ProcessTerminated = 1 as const
  static TaskFailed = 2 as const
  static InvalidSignal = 3 as const
  static InvalidTask = 4 as const
}
