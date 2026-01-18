import { spawn, type ChildProcess } from "node:child_process"

import { $TASK_INTERNAL, $PIPELINE_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { PipelineError } from "./pipeline-error.js"
import { createScheduler, type SchedulerInput } from "./scheduler.js"
import { task } from "./task.js"
import { validateTasks } from "./util.js"
import { createTeardownManager } from "./modules/teardown-manager.js"
import { createSignalHandler } from "./modules/signal-handler.js"
import { executeTask } from "./modules/task-executor.js"
import type {
  Pipeline,
  Task,
  PipelineTaskConfig,
  RunResult,
  PipelineStats,
  TaskStats,
} from "./types.js"

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
  const tasksClone = [...tasks]
  validateTasks(tasksClone)

  const graph = createTaskGraph(tasksClone)
  graph.validate()
  graph.simplify()

  const pipelineImpl: Pipeline = {
    [$PIPELINE_INTERNAL]: {
      tasks: tasksClone,
      graph,
    },

    toTask({ name, dependencies, env }: PipelineTaskConfig): Task {
      const syntheticTask = task({
        name,
        commands: {},
        dependencies,
        env,
      })

      // Mark this task as a pipeline task so it can be detected by the executor
      syntheticTask[$TASK_INTERNAL].pipeline = pipelineImpl

      return syntheticTask
    },

    async run(config): Promise<RunResult> {
      const spawnFn = config?.spawn ?? spawn
      const signal = config?.signal
      const runningTasks = new Map<string, ChildProcess>()
      const runningPipelines = new Map<string, { stop: () => void }>()
      let failed = false

      const command =
        config?.command ??
        (process.env.NODE_ENV === "production" ? "build" : "dev")
      const startedAt = Date.now()

      // Initialize task stats tracking
      const taskStats = new Map<string, TaskStats>()
      for (const [taskId, node] of graph.nodes) {
        const task = node.task
        taskStats.set(taskId, {
          id: taskId,
          name: task.name,
          status: "pending",
          dependencies: Array.from(node.dependencies),
          dependents: Array.from(node.dependents),
        })
      }

      // Helper to update task status
      const updateTaskStatus = (
        taskId: string,
        updates: Partial<TaskStats>
      ) => {
        const stats = taskStats.get(taskId)
        if (stats) {
          Object.assign(stats, updates)
        }
      }

      // Check if signal is already aborted
      if (signal?.aborted) {
        const error = new PipelineError("Aborted", PipelineError.Aborted)
        return buildResult(error, startedAt, command, taskStats, "aborted")
      }

      const scheduler = createScheduler(graph)

      let completionResolver: ((error: PipelineError | null) => void) | null =
        null
      const completionPromise = new Promise<PipelineError | null>((resolve) => {
        completionResolver = resolve
      })

      // Initialize teardown manager with stats tracking
      const teardownManager = createTeardownManager({
        ...config,
        spawn: spawnFn,
        updateTaskTeardownStatus: (taskId, status, error) => {
          const stats = taskStats.get(taskId)
          if (stats) {
            stats.teardown = { status, error }
          }
        },
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
            completionResolver?.(null)
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

        // Mark running tasks as aborted
        for (const [taskId, child] of runningTasks.entries()) {
          updateTaskStatus(taskId, {
            status: "aborted",
            finishedAt: Date.now(),
          })
          const stats = taskStats.get(taskId)
          if (stats && stats.startedAt) {
            stats.durationMs = stats.finishedAt! - stats.startedAt
          }
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

        completionResolver?.(error)
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
          failPipeline,
          advanceScheduler,
          updateTaskStatus,
          taskStats,
        })
      }

      // Initialize signal handler
      const signalHandler = createSignalHandler({
        abortSignal: signal,
        onAborted: () =>
          failPipeline(new PipelineError("Aborted", PipelineError.Aborted)),
        onProcessTerminated: (message) =>
          new PipelineError(message, PipelineError.ProcessTerminated),
      })

      // 🚀 Kick off initial runnable tasks
      advanceScheduler()

      const error = await completionPromise.then(async (err) => {
        // Pipeline completed - execute any remaining teardowns
        // (for tasks that completed successfully) and wait for them to complete
        // Even if teardowns fail, the pipeline still resolves successfully
        // (teardown errors are reported via onTaskTeardownError)
        try {
          await teardownManager.executeAll(graph)
        } catch (teardownError) {
          // Teardown errors are already reported via onTaskTeardownError
          // The pipeline still resolves successfully
        }
        return err
      })

      signalHandler.cleanup()

      const status: "success" | "failed" | "aborted" = error
        ? error.code === PipelineError.Aborted
          ? "aborted"
          : "failed"
        : "success"

      return buildResult(error, startedAt, command, taskStats, status)
    },
  }

  return pipelineImpl
}

function buildResult(
  error: PipelineError | null,
  startedAt: number,
  command: string,
  taskStats: Map<string, TaskStats>,
  status: "success" | "failed" | "aborted"
): RunResult {
  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt

  // Convert task stats map to record
  const tasks: Record<string, TaskStats> = {}
  for (const [taskId, stats] of taskStats) {
    tasks[taskId] = stats
  }

  // Calculate summary
  let completed = 0
  let failed = 0
  let skipped = 0
  let running = 0

  for (const stats of taskStats.values()) {
    switch (stats.status) {
      case "completed":
        completed++
        break
      case "failed":
        failed++
        break
      case "skipped":
        skipped++
        break
      case "running":
        running++
        break
    }
  }

  const pipelineStats: PipelineStats = {
    command,
    startedAt,
    finishedAt,
    durationMs,
    status,
    tasks,
    summary: {
      total: taskStats.size,
      completed,
      failed,
      skipped,
      running,
    },
  }

  if (error) {
    return { ok: false, error, stats: pipelineStats }
  } else {
    return { ok: true, error: null, stats: pipelineStats }
  }
}
