import { spawn, ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import * as path from "node:path"

import type { Pipeline, Task } from "./types.js"
import { $TASK_INTERNAL } from "./constants.js"

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 */
export function pipeline(tasks: Task[]): Pipeline {
  return {
    async run(): Promise<void> {
      const eventEmitter = new EventEmitter<{
        taskReady: [taskName: string]
        taskCompleted: [taskName: string]
      }>()
      const runningTasks = new Map<string, ChildProcess>()
      const completedTasks = new Set<string>()
      const readyTasks = new Set<string>()

      // Determine which command to use based on NODE_ENV
      const isProduction = process.env.NODE_ENV === "production"
      const getCommand = (task: Task): string => {
        return isProduction
          ? task[$TASK_INTERNAL].commands.build
          : task[$TASK_INTERNAL].commands.dev
      }

      // Function to check if a task's dependencies are satisfied
      const canStart = async (task: Task): Promise<boolean> => {
        if (runningTasks.has(task.name) || completedTasks.has(task.name)) {
          return false
        }

        const { dependsOn: dependencies } = task[$TASK_INTERNAL]

        if (!dependencies || dependencies.length === 0) {
          return true
        }

        // Wait for all dependencies
        for (const dep of dependencies) {
          if (typeof dep === "function") {
            await dep()
          } else {
            await dep
          }
        }

        return true
      }

      // Function to start a task
      const startTask = async (task: Task): Promise<void> => {
        if (runningTasks.has(task.name)) {
          return
        }

        const command = getCommand(task)
        const { cwd, readyOn, markComplete, markReady } = task[$TASK_INTERNAL]

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

        const child = spawn(command, {
          cwd,
          stdio: ["inherit", "pipe", "pipe"],
          shell: true,
          env,
        })

        // Handle spawn errors
        child.on("error", (error) => {
          console.error(`[${task.name}] Failed to start:`, error.message)
          runningTasks.delete(task.name)
          completedTasks.add(task.name)
          markComplete()
          process.exitCode = 1
          eventEmitter.emit("taskCompleted", task.name)
        })

        runningTasks.set(task.name, child)

        // If task doesn't have readyOn, mark as ready immediately
        if (!readyOn) {
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
            if (readyOn && !readyTasks.has(task.name)) {
              if (readyOn(allOutput)) {
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
          markComplete()

          if (code !== 0) {
            process.exitCode = code || 1
          }

          eventEmitter.emit("taskCompleted", task.name)
        })
      }

      // Function to try starting tasks when dependencies are ready
      const tryStartTasks = async () => {
        for (const task of tasks) {
          if (await canStart(task)) {
            await startTask(task)
          }
        }
      }

      // Listen for task readiness and completion to start dependent tasks
      eventEmitter.on("taskReady", tryStartTasks)
      eventEmitter.on("taskCompleted", tryStartTasks)

      // Start tasks that don't have dependencies
      await tryStartTasks()

      // Wait for all tasks to complete
      return new Promise<void>((resolve, reject) => {
        const checkCompletion = () => {
          if (runningTasks.size === 0) {
            resolve()
          }
        }

        eventEmitter.on("taskCompleted", checkCompletion)
        checkCompletion()

        // Handle process termination
        process.on("SIGINT", () => {
          for (const child of runningTasks.values()) {
            child.kill("SIGINT")
          }
          reject(new Error("Process interrupted"))
        })

        process.on("SIGTERM", () => {
          for (const child of runningTasks.values()) {
            child.kill("SIGTERM")
          }
          reject(new Error("Process terminated"))
        })
      })
    },
  }
}
