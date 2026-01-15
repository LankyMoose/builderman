import { spawn, ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import * as path from "node:path"
import * as fs from "node:fs"

import type { Pipeline, Task } from "./types.js"
import { $TASK_INTERNAL } from "./constants.js"

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 */
export function pipeline(tasks: Task[]): Pipeline {
  return {
    run(config): Promise<void> {
      return new Promise((resolvePipeline, rejectPipeline) => {
        let hasFailed = false

        // Function to fail the pipeline and kill all running tasks
        const failPipeline = (error: Error) => {
          if (hasFailed) return
          hasFailed = true

          // Kill all running tasks
          for (const child of runningTasks.values()) {
            try {
              child.kill("SIGTERM")
            } catch (e) {
              // Ignore errors when killing
            }
          }

          rejectPipeline(error)
        }

        const eventEmitter = new EventEmitter<{
          taskReady: [taskName: string]
          taskCompleted: [taskName: string]
        }>()
        const runningTasks = new Map<string, ChildProcess>()
        const completedTasks = new Set<string>()
        const readyTasks = new Set<string>()

        const isProduction = process.env.NODE_ENV === "production"
        const getCommand = (task: Task): string => {
          return isProduction
            ? task[$TASK_INTERNAL].commands.build
            : task[$TASK_INTERNAL].commands.dev
        }

        const canStart = async (task: Task): Promise<boolean> => {
          if (runningTasks.has(task.name) || completedTasks.has(task.name)) {
            return false
          }

          const { dependencies } = task[$TASK_INTERNAL]

          if (!dependencies || dependencies.length === 0) {
            return true
          }

          await Promise.all(
            dependencies.map((task) => task[$TASK_INTERNAL].readyPromise)
          )
          return true
        }

        const startTask = (task: Task) => {
          if (runningTasks.has(task.name)) {
            return
          }

          const command = getCommand(task)
          const {
            cwd,
            isReady: getIsReady,
            markComplete,
            markReady,
          } = task[$TASK_INTERNAL]

          // Ensure node_modules/.bin is in PATH for local dependencies
          const taskCwd = path.isAbsolute(cwd)
            ? cwd
            : path.resolve(process.cwd(), cwd)
          const localBinPath = path.join(taskCwd, "node_modules", ".bin")

          // Build PATH with local node_modules/.bin first
          const existingPath = process.env.PATH || process.env.Path || ""
          const pathSeparator = process.platform === "win32" ? ";" : ":"

          const binPaths: string[] = [localBinPath]

          const rootBinPath = path.join(process.cwd(), "node_modules", ".bin")
          if (rootBinPath !== localBinPath) {
            binPaths.push(rootBinPath)
          }

          if (existingPath) {
            binPaths.push(existingPath)
          }

          const newPath = binPaths.join(pathSeparator)

          const env = {
            ...process.env,
            PATH: newPath,
            Path: newPath,
          }

          // Validate that the cwd exists
          if (!fs.existsSync(taskCwd)) {
            const error = new Error(
              `[${task.name}] Working directory does not exist: ${taskCwd}`
            )
            config.onTaskError?.(task.name, error)
            failPipeline(error)
            return
          }

          // Use the resolved absolute path for cwd
          const child = spawn(command, {
            cwd: taskCwd,
            stdio: ["inherit", "pipe", "pipe"],
            shell: true,
            env,
          })

          // Handle spawn errors
          child.on("error", (error) => {
            const errorMsg = `[${task.name}] Failed to start: ${error.message}\n  Command: ${command}\n  CWD: ${taskCwd}`
            const e = new Error(errorMsg)
            config.onTaskError?.(task.name, e)
            failPipeline(e)
          })

          runningTasks.set(task.name, child)

          // If task doesn't have getIsReady, mark as ready immediately
          if (!getIsReady) {
            readyTasks.add(task.name)
            markReady()
            eventEmitter.emit("taskReady", task.name)
          }

          // Monitor stdout for readiness
          let stdoutBuffer = ""
          let allOutput = ""

          child.stdout?.on("data", (data: Buffer) => {
            const chunk = data.toString()
            allOutput += chunk
            stdoutBuffer += chunk
            const lines = stdoutBuffer.split("\n")
            stdoutBuffer = lines.pop() || ""

            for (const line of lines) {
              // Check if task is ready based on readyOn callback
              if (getIsReady && !readyTasks.has(task.name)) {
                if (getIsReady(allOutput)) {
                  readyTasks.add(task.name)
                  markReady()
                  eventEmitter.emit("taskReady", task.name)
                }
              }

              // Forward stdout to parent
              process.stdout.write(line + "\n")
            }
          })

          // Forward any remaining buffer on end
          child.stdout?.on("end", () => {
            if (stdoutBuffer) {
              process.stdout.write(stdoutBuffer)
            }
          })

          // Forward stderr
          child.stderr?.on("data", (data: Buffer) => {
            process.stderr.write(data)
          })

          // Handle task completion
          child.on("exit", (code) => {
            runningTasks.delete(task.name)
            completedTasks.add(task.name)

            if (code !== 0) {
              const error = new Error(
                `[${task.name}] Task failed with exit code ${code || 1}`
              )
              config.onTaskError?.(task.name, error)
              failPipeline(error)
            } else {
              markComplete()
              eventEmitter.emit("taskCompleted", task.name)
              config.onTaskComplete?.(task.name)
            }
          })
        }

        const tryStartTasks = async () => {
          for (const task of tasks) {
            if (await canStart(task)) {
              startTask(task)
            }
          }
        }

        // Function to check completion (only resolve if no failures)
        const checkCompletion = () => {
          if (completedTasks.size === tasks.length && !hasFailed) {
            config.onPipelineComplete?.()
            resolvePipeline()
          }
        }

        // Handle process termination
        ;["SIGINT", "SIGBREAK", "SIGTERM", "SIGQUIT"].forEach((signal) => {
          process.once(signal, () => {
            const e = new Error(
              `Received ${signal} signal during pipeline execution`
            )
            config.onPipelineError?.(e)
            failPipeline(e)
          })
        })

        eventEmitter.on("taskReady", tryStartTasks)
        eventEmitter.on("taskCompleted", tryStartTasks)
        eventEmitter.on("taskCompleted", checkCompletion)
        tryStartTasks().catch(failPipeline)
      })
    },
  }
}
