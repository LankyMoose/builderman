import { spawn, ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

import { $TASK_INTERNAL } from "./constants.js"
import { createTaskGraph } from "./graph.js"
import { createScheduler, SchedulerInput } from "./scheduler.js"
import type { Pipeline, Task } from "./types.js"

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 * @param tasks - Array of tasks to execute
 * @param spawnFn - Optional spawn function for testing (defaults to node:child_process spawn)
 */

export function pipeline(
  tasks: Task[],
  spawnFn: typeof import("node:child_process").spawn = spawn
): Pipeline {
  const graph = createTaskGraph(tasks)
  graph.validate()
  graph.simplify()

  return {
    async run(config): Promise<void> {
      const runningTasks = new Map<number, ChildProcess>()
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

        config.onPipelineError?.(error)
        completionRejector?.(error)
      }

      const startTask = (task: Task) => {
        const {
          name: taskName,
          [$TASK_INTERNAL]: { id: taskId },
        } = task

        if (runningTasks.has(taskId)) return

        const command =
          process.env.NODE_ENV === "production"
            ? task[$TASK_INTERNAL].commands.build
            : task[$TASK_INTERNAL].commands.dev

        const { cwd, isReady, markReady, markComplete } = task[$TASK_INTERNAL]

        const taskCwd = path.isAbsolute(cwd)
          ? cwd
          : path.resolve(process.cwd(), cwd)

        if (!fs.existsSync(taskCwd)) {
          const e = new Error(
            `[${taskName}] Working directory does not exist: ${taskCwd}`
          )
          config.onTaskError?.(taskName, e)
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

        if (!isReady) {
          markReady()
        }

        let output = ""

        child.stdout?.on("data", (buf) => {
          const chunk = buf.toString()
          output += chunk
          process.stdout.write(chunk)

          if (isReady && isReady(output)) {
            markReady()
          }
        })

        child.stderr?.on("data", (buf) => {
          process.stderr.write(buf)
        })

        child.on("error", (error) => {
          const e = new Error(`[${taskName}] Failed to start: ${error.message}`)
          config.onTaskError?.(taskName, e)
          failPipeline(e)
        })

        child.on("exit", (code) => {
          runningTasks.delete(taskId)

          if (code !== 0) {
            const e = new Error(
              `[${taskName}] Task failed with exit code ${code ?? 1}`
            )
            config.onTaskError?.(taskName, e)
            failPipeline(e)
            return
          }

          markComplete()
          config.onTaskComplete?.(taskName)

          // 🔑 Notify scheduler and drain newly runnable tasks
          advanceScheduler({ type: "complete", taskId })
        })
      }

      const advanceScheduler = (input?: SchedulerInput) => {
        let result = input ? scheduler.next(input) : scheduler.next()

        while (!result.done) {
          const event = result.value

          if (event.type === "run") {
            startTask(graph.nodes.get(event.taskId)!.task)
            result = scheduler.next()
            continue
          }

          if (event.type === "idle") {
            return
          }

          if (event.type === "done") {
            config.onPipelineComplete?.()
            completionResolver?.()
            return
          }
        }
      }

      // Handle termination signals
      ;["SIGINT", "SIGTERM", "SIGQUIT", "SIGBREAK"].forEach((signal) => {
        process.once(signal, () => {
          failPipeline(new Error(`Received ${signal}`))
        })
      })

      // 🚀 Kick off initial runnable tasks
      advanceScheduler()

      await completionPromise
    },
  }
}
