import { spawn, ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { createScheduler, SchedulerInput } from "./scheduler.js"
import { task } from "./task.js"
import { validateTasks } from "./util.js"
import type { Pipeline, Task, PipelineTaskConfig, TaskConfig } from "./types.js"

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
    andThen(next: Omit<TaskConfig, "dependencies">): Pipeline {
      // Find exit nodes (tasks with no dependents) - these are the "last" tasks
      const exitNodes: Task[] = []
      for (const node of graph.nodes.values()) {
        if (node.dependents.size === 0) {
          exitNodes.push(node.task)
        }
      }

      // Collect all tasks from the current pipeline
      const allTasks: Task[] = []
      for (const node of graph.nodes.values()) {
        allTasks.push(node.task)
      }

      // Create a task that depends on exit nodes
      const nextTask = task({
        ...next,
        dependencies: exitNodes,
      })
      allTasks.push(nextTask)

      return pipeline(allTasks)
    },
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
      const runningTasks = new Map<number, ChildProcess>()
      const runningPipelines = new Map<number, { stop: () => void }>()
      let failed = false

      const scheduler = createScheduler(graph)

      let completionResolver: (() => void) | null = null
      let completionRejector: ((error: Error) => void) | null = null
      const completionPromise = new Promise<void>((resolve, reject) => {
        completionResolver = resolve
        completionRejector = reject
      })

      const failPipeline = (error: Error) => {
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
        const {
          name: taskName,
          [$TASK_INTERNAL]: { id: taskId, pipeline: nestedPipeline },
        } = task

        if (runningTasks.has(taskId)) return

        // Handle pipeline tasks
        if (nestedPipeline) {
          // Mark as ready immediately (pipeline entry nodes will handle their own ready state)
          advanceScheduler({ type: "ready", taskId })

          // Create an abort controller to stop the nested pipeline if needed
          let pipelineStopped = false
          const stopPipeline = () => {
            pipelineStopped = true
            // The nested pipeline will continue running, but we've marked it as stopped
            // In a more sophisticated implementation, we could propagate stop signals
          }

          runningPipelines.set(taskId, { stop: stopPipeline })

          // Run the nested pipeline
          nestedPipeline
            .run({
              spawn: spawnFn,
              onTaskError: (nestedTaskName, error) => {
                if (pipelineStopped) return
                config?.onTaskError?.(`${taskName}:${nestedTaskName}`, error)
              },
              onTaskComplete: (nestedTaskName) => {
                if (pipelineStopped) return
                config?.onTaskComplete?.(`${taskName}:${nestedTaskName}`)
              },
              onPipelineError: (error) => {
                if (pipelineStopped) return
                runningPipelines.delete(taskId)
                const e = new Error(
                  `[${taskName}] Pipeline failed: ${error.message}`
                )
                config?.onTaskError?.(taskName, e)
                failPipeline(e)
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
              const e = new Error(
                `[${taskName}] Pipeline failed: ${error.message}`
              )
              config?.onTaskError?.(taskName, e)
              failPipeline(e)
            })

          return
        }

        // Regular task execution
        const command =
          process.env.NODE_ENV === "production"
            ? task[$TASK_INTERNAL].commands.build
            : task[$TASK_INTERNAL].commands.dev

        const { cwd, shouldStdoutMarkReady } = task[$TASK_INTERNAL]

        const taskCwd = path.isAbsolute(cwd)
          ? cwd
          : path.resolve(process.cwd(), cwd)

        if (!fs.existsSync(taskCwd)) {
          const e = new Error(
            `[${taskName}] Working directory does not exist: ${taskCwd}`
          )
          config?.onTaskError?.(taskName, e)
          failPipeline(e)
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

        let didMarkReady = false
        if (!shouldStdoutMarkReady) {
          advanceScheduler({ type: "ready", taskId })
          didMarkReady = true
        }

        let output = ""

        child.stdout?.on("data", (buf) => {
          const chunk = buf.toString()
          output += chunk
          process.stdout.write(chunk)

          if (!didMarkReady && shouldStdoutMarkReady!(output)) {
            advanceScheduler({ type: "ready", taskId })
            didMarkReady = true
          }
        })

        child.stderr?.on("data", (buf) => {
          process.stderr.write(buf)
        })

        child.on("error", (error) => {
          const e = new Error(`[${taskName}] Failed to start: ${error.message}`)
          config?.onTaskError?.(taskName, e)
          failPipeline(e)
        })

        child.on("exit", (code) => {
          runningTasks.delete(taskId)

          if (code !== 0) {
            const e = new Error(
              `[${taskName}] Task failed with exit code ${code ?? 1}`
            )
            config?.onTaskError?.(taskName, e)
            failPipeline(e)
            return
          }

          config?.onTaskComplete?.(taskName)

          // 🔑 Notify scheduler and drain newly runnable tasks
          advanceScheduler({ type: "complete", taskId })
        })
      }

      const advanceScheduler = (input?: SchedulerInput) => {
        let result = input ? scheduler.next(input) : scheduler.next()

        while (true) {
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
      const cleanups = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGBREAK"].map(
        (signal) => {
          const handleSignal = () => {
            failPipeline(new Error(`Received ${signal}`))
          }
          process.once(signal, handleSignal)
          return () => {
            process.removeListener(signal, handleSignal)
          }
        }
      )

      // 🚀 Kick off initial runnable tasks
      advanceScheduler()

      await completionPromise.finally(() => {
        cleanups.forEach((cleanup) => cleanup())
      })
    },
  }

  return pipelineImpl
}
