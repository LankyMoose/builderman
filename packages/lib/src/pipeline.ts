import { spawn, type ChildProcess } from "node:child_process"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { PipelineError } from "./pipeline-error.js"
import { createScheduler, type SchedulerInput } from "./scheduler.js"
import { task } from "./task.js"
import { validateTasks } from "./util.js"
import { createTeardownManager } from "./modules/teardown-manager.js"
import { createSignalHandler } from "./modules/signal-handler.js"
import { executeTask } from "./modules/task-executor.js"
import type { Pipeline, Task, PipelineTaskConfig } from "./types.js"

// Module-level cache for pipeline-to-task conversions
// Key: Pipeline, Value: Map of name -> Task
const pipelineTaskCache = new WeakMap<Pipeline, Map<string, Task>>()

// Store tasks for each pipeline (for nested pipeline skip tracking)
const pipelineTasksCache = new WeakMap<Pipeline, Task[]>()

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 * @param tasks - The tasks to include in the pipeline.
 * @returns A pipeline that can be used to execute the tasks.
 * @example
 * const task1 = task({ name: "task1", commands: { dev: "echo task1" }, cwd: "." })
 * const task2 = task({ name: "task2", commands: { dev: "echo task2" }, cwd: ".", dependencies: [task1] })
 * await pipeline([task1, task2]).run()
 */
export function pipeline(tasks: Task[]): Pipeline {
  validateTasks(tasks)

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
      const runningTasks = new Map<string, ChildProcess>()
      const runningPipelines = new Map<string, { stop: () => void }>()
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

      // Initialize teardown manager
      const teardownManager = createTeardownManager({
        ...config,
        spawn: spawnFn,
      })

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
          await teardownManager.executeAll(graph)
        } catch (teardownError) {
          // Teardown errors are already reported via onTaskTeardownError
          // We continue to reject the pipeline with the original error
        }

        config?.onPipelineError?.(error)
        completionRejector?.(error)
      }

      const startTask = (task: Task) => {
        executeTask(task, {
          spawn: spawnFn,
          signal,
          config,
          graph,
          runningTasks,
          runningPipelines,
          teardownManager,
          pipelineTasksCache,
          failPipeline,
          advanceScheduler,
        })
      }

      // Initialize signal handler
      const signalHandler = createSignalHandler({
        abortSignal: signal,
        onAborted: () => failPipeline(new PipelineError("Aborted", PipelineError.Aborted)),
        onProcessTerminated: (message) =>
          new PipelineError(message, PipelineError.ProcessTerminated),
      })

      // 🚀 Kick off initial runnable tasks
      advanceScheduler()

      await completionPromise
        .then(async () => {
          // Pipeline completed successfully - execute any remaining teardowns
          // (for tasks that completed successfully) and wait for them to complete
          // Even if teardowns fail, the pipeline still resolves successfully
          // (teardown errors are reported via onTaskTeardownError)
          try {
            await teardownManager.executeAll(graph)
          } catch (teardownError) {
            // Teardown errors are already reported via onTaskTeardownError
            // The pipeline still resolves successfully
          }
        })
        .finally(() => {
          signalHandler.cleanup()
        })
    },
  }

  // Store tasks for nested pipeline skip tracking
  pipelineTasksCache.set(pipelineImpl, tasks)

  return pipelineImpl
}

