import { EventEmitter } from "node:events"
import { mock } from "node:test"
import type { ChildProcess } from "node:child_process"

// Test helpers
export interface CommandHandler {
  exitCode?: number | null
  exitDelay?: number
  onSpawn?: (process: ChildProcess) => void
}

export function createMockSpawn(options?: {
  // Default behavior for all commands
  exitCode?: number | null
  // Command-specific handlers (checked in order)
  commands?: Array<{
    match: string | RegExp | ((command: string) => boolean)
    handler: CommandHandler
  }>
  // Fallback handler for unmatched commands
  commandHandler?: (command: string, process: ChildProcess) => void
}): ReturnType<typeof mock.fn> {
  return mock.fn((command: string) => {
    const mockProcess = new EventEmitter() as ChildProcess
    mockProcess.kill = mock.fn() as any
    mockProcess.stdout = new EventEmitter() as any
    mockProcess.stderr = new EventEmitter() as any

    // Find matching command handler
    let matchedHandler: CommandHandler | undefined
    if (options?.commands) {
      for (const cmd of options.commands) {
        let matches = false
        if (typeof cmd.match === "string") {
          matches = command.includes(cmd.match)
        } else if (cmd.match instanceof RegExp) {
          matches = cmd.match.test(command)
        } else {
          matches = cmd.match(command)
        }
        if (matches) {
          matchedHandler = cmd.handler
          break
        }
      }
    }

    // Apply handler
    const handler = matchedHandler || {}
    const exitCode = handler.exitCode ?? options?.exitCode ?? 0
    const exitDelay = handler.exitDelay ?? 0

    // Handler onSpawn
    handler.onSpawn?.(mockProcess)

    // Fallback commandHandler
    if (!matchedHandler && options?.commandHandler) {
      options.commandHandler(command, mockProcess)
      // When commandHandler is used, it handles exit, so don't auto-exit
      return mockProcess
    }

    // Auto-exit unless disabled
    if (exitDelay > 0) {
      setTimeout(() => {
        mockProcess.emit("exit", exitCode)
      }, exitDelay)
    } else {
      setImmediate(() => {
        mockProcess.emit("exit", exitCode)
      })
    }

    return mockProcess
  }) as any
}
