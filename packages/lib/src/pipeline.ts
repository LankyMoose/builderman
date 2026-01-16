import { spawn, ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { createScheduler, SchedulerInput } from "./scheduler.js"
import { task } from "./task.js"
import { validateTasks } from "./util.js"
import type { Pipeline, Task, PipelineTaskConfig } from "./types.js"

// Module-level cache for pipeline-to-task conversions
// Key: Pipeline, Value: Map of name -> Task
const pipelineTaskCache = new WeakMap<Pipeline, Map<string, Task>>()

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
        commands: { dev: ":", build: ":" }, // Dummy commands (no-op)
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

      const failPipeline = (error: PipelineError) => {
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
              signal, // Pass signal to nested pipeline
              onTaskBegin: (nestedTaskName) => {
                if (pipelineStopped) return
                config?.onTaskBegin?.(`${taskName}:${nestedTaskName}`)
              },
              onTaskComplete: (nestedTaskName) => {
                if (pipelineStopped) return
                config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`)
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
                config?.onTaskComplete?.(taskName)
                advanceScheduler({ type: "complete", taskId })
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
        const commandConfig =
          process.env.NODE_ENV === "production"
            ? task[$TASK_INTERNAL].commands.build
            : task[$TASK_INTERNAL].commands.dev

        const command =
          typeof commandConfig === "string" ? commandConfig : commandConfig.run
        const readyWhen =
          typeof commandConfig === "string"
            ? undefined
            : commandConfig.readyWhen

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
          failPipeline(
            new PipelineError(
              `[${taskName}] Failed to start: ${error.message}`,
              PipelineError.TaskFailed
            )
          )
        })

        child.on("exit", (code) => {
          runningTasks.delete(taskId)

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

      await completionPromise.finally(() => {
        processTerminationListenerCleanups.forEach((cleanup) => cleanup())
        signalCleanup?.()
      })
    },
  }

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
  constructor(message: string, code: PipelineErrorCode) {
    super(message)
    this.name = "PipelineError"
    this.code = code
  }

  static Aborted = 0 as const
  static ProcessTerminated = 1 as const
  static TaskFailed = 2 as const
  static InvalidSignal = 3 as const
  static InvalidTask = 4 as const
}
