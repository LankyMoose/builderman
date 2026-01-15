import { spawn, ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"

export interface TaskConfig {
  name: string
  command: string
  cwd: string
  requiresEvents?: string[]
}

export interface Task extends TaskConfig {
  requiresEvents: string[]
}

export interface Pipeline {
  run(): Promise<void>
}

const EVENT_PREFIX = "__BUILDERMAN_EVENT__:"

/**
 * Emits an event that can be received by the parent process.
 * Events are written to stdout in a parseable format.
 */
export function emit(event: string): void {
  const eventData = JSON.stringify({ event })
  console.log(`${EVENT_PREFIX}${eventData}`)
}

/**
 * Creates a task configuration.
 */
export function task(config: TaskConfig): Task {
  return {
    name: config.name,
    command: config.command,
    cwd: config.cwd,
    requiresEvents: config.requiresEvents || [],
  }
}

/**
 * Creates a pipeline that manages task execution with event-based dependencies.
 */
export function pipeline(tasks: Task[]): Pipeline {
  return {
    async run(): Promise<void> {
      const eventEmitter = new EventEmitter<{
        event: [eventName: string]
        taskCompleted: [taskName: string]
      }>()
      const emittedEvents = new Set<string>()
      const runningTasks = new Map<string, ChildProcess>()
      const completedTasks = new Set<string>()
      const taskConfigs = new Map<string, Task>()

      // Index tasks by name
      for (const task of tasks) {
        taskConfigs.set(task.name, task)
      }

      // Function to check if a task can start
      const canStart = (task: Task): boolean => {
        if (runningTasks.has(task.name) || completedTasks.has(task.name)) {
          return false
        }
        return task.requiresEvents.every((event) => emittedEvents.has(event))
      }

      // Function to start a task
      const startTask = (task: Task): void => {
        if (runningTasks.has(task.name)) {
          return
        }

        const [command, ...args] = task.command.split(/\s+/)
        const child = spawn(command, args, {
          cwd: task.cwd,
          stdio: ["inherit", "pipe", "pipe"],
          shell: process.platform === "win32",
        })

        runningTasks.set(task.name, child)

        // Parse events from stdout
        let stdoutBuffer = ""
        child.stdout?.on("data", (data: Buffer) => {
          stdoutBuffer += data.toString()
          const lines = stdoutBuffer.split("\n")
          stdoutBuffer = lines.pop() || ""

          for (const line of lines) {
            if (line.startsWith(EVENT_PREFIX)) {
              try {
                const eventData = JSON.parse(
                  line.slice(EVENT_PREFIX.length)
                ) as { event: string }
                const eventName = eventData.event
                if (eventName && !emittedEvents.has(eventName)) {
                  emittedEvents.add(eventName)
                  eventEmitter.emit("event", eventName)
                }
              } catch (e) {
                // Ignore parse errors
              }
              // Don't forward event lines to stdout
            } else {
              // Forward stdout to parent
              process.stdout.write(line + "\n")
            }
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
            process.exitCode = code || 1
          }

          // Check if any waiting tasks can now start
          eventEmitter.emit("taskCompleted", task.name)
        })
      }

      // Listen for events and task completions to start new tasks
      eventEmitter.on("event", () => {
        for (const task of tasks) {
          if (canStart(task)) {
            startTask(task)
          }
        }
      })

      eventEmitter.on("taskCompleted", () => {
        for (const task of tasks) {
          if (canStart(task)) {
            startTask(task)
          }
        }
      })

      // Start tasks that don't have dependencies
      for (const task of tasks) {
        if (canStart(task)) {
          startTask(task)
        }
      }

      // Wait for all tasks to complete
      return new Promise<void>((resolve, reject) => {
        const checkCompletion = () => {
          if (runningTasks.size === 0) {
            resolve()
          }
        }

        eventEmitter.on("taskCompleted", checkCompletion)
        checkCompletion() // Check immediately in case all tasks completed synchronously

        // Handle process termination
        process.on("SIGINT", () => {
          // Kill all running tasks
          for (const child of runningTasks.values()) {
            child.kill("SIGINT")
          }
          reject(new Error("Process interrupted"))
        })

        process.on("SIGTERM", () => {
          // Kill all running tasks
          for (const child of runningTasks.values()) {
            child.kill("SIGTERM")
          }
          reject(new Error("Process terminated"))
        })
      })
    },
  }
}
