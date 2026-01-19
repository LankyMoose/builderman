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
  // Match against the command string (cmd) or full command line
  commands?: Array<{
    match: string | RegExp | ((cmd: string, args: string[]) => boolean)
    handler: CommandHandler
  }>
  // Fallback handler for unmatched commands
  commandHandler?: (cmd: string, args: string[], process: ChildProcess) => void
}): ReturnType<typeof mock.fn> {
  return mock.fn((cmd: string, args: string[] = [], _spawnOptions?: any) => {
    const mockProcess = new EventEmitter() as ChildProcess
    mockProcess.kill = mock.fn() as any
    mockProcess.stdout = new EventEmitter() as any
    mockProcess.stderr = new EventEmitter() as any

    // Reconstruct command string for matching (for backwards compatibility)
    const commandString = [cmd, ...args].join(" ")

    // Find matching command handler
    let matchedHandler: CommandHandler | undefined
    if (options?.commands) {
      for (const cmdConfig of options.commands) {
        let matches = false
        if (typeof cmdConfig.match === "string") {
          matches =
            commandString.includes(cmdConfig.match) ||
            cmd.includes(cmdConfig.match)
        } else if (cmdConfig.match instanceof RegExp) {
          matches =
            cmdConfig.match.test(commandString) || cmdConfig.match.test(cmd)
        } else {
          matches = cmdConfig.match(cmd, args)
        }
        if (matches) {
          matchedHandler = cmdConfig.handler
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
      options.commandHandler(cmd, args, mockProcess)
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
