import { $TASK_INTERNAL } from "./constants.js"
import type { Task } from "../types.js"

export function validateTasks(tasks?: Task[]): void {
  if (tasks?.some((dep) => !($TASK_INTERNAL in dep))) {
    throw new Error(
      "Invalid dependency: must be a task or a pipeline converted to a task"
    )
  }
}

/**
 * Very small, cross-platform command-line parser for our default spawn wrapper.
 * - Splits on whitespace outside of single/double quotes
 * - Strips the surrounding quotes
 * - Does NOT implement full shell semantics (no pipes, redirects, etc.)
 *
 * This is sufficient for commands like:
 * - `"node path/to/script.js"`
 * - `"\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\path with spaces\\script.js\""`
 */
export function parseCommandLine(command: string): {
  cmd: string
  args: string[]
} {
  const tokens: string[] = []
  let current = ""
  let inQuotes = false
  let quoteChar: '"' | "'" | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (ch === '"' || ch === "'") {
      if (!inQuotes) {
        inQuotes = true
        quoteChar = ch
        continue
      }

      if (quoteChar === ch) {
        inQuotes = false
        quoteChar = null
        continue
      }

      // Different quote type inside current quotes – treat as literal
      current += ch
      continue
    }

    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += ch
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  if (tokens.length === 0) {
    throw new Error(`Invalid command: "${command}"`)
  }

  const [cmd, ...args] = tokens
  return { cmd, args }
}
