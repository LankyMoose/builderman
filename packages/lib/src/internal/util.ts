import * as path from "node:path"
import * as fs from "node:fs"

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

/**
 * Resolves an executable command from PATH.
 * When using spawn with shell: false, Node.js doesn't automatically resolve
 * executables from PATH like a shell would. This function searches PATH
 * directories to find the executable.
 *
 * On Windows, .cmd and .bat files need to be executed via cmd.exe when using shell: false.
 *
 * @param cmd - The command name to resolve (e.g., "pnpm", "node")
 * @param pathEnv - The PATH environment variable value
 * @returns An object with the resolved command and whether it needs cmd.exe wrapper on Windows
 */
export function resolveExecutable(
  cmd: string,
  pathEnv: string | undefined
): { cmd: string; needsCmdWrapper: boolean } {
  // If cmd is already an absolute path or contains path separators, return as-is
  if (path.isAbsolute(cmd) || cmd.includes(path.sep)) {
    return { cmd, needsCmdWrapper: false }
  }

  // If no PATH provided, return original cmd
  if (!pathEnv) {
    return { cmd, needsCmdWrapper: false }
  }

  const pathDirs = pathEnv.split(process.platform === "win32" ? ";" : ":")

  // On Windows, check for .exe, .cmd, .bat extensions
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]

  for (const dir of pathDirs) {
    if (!dir) continue

    for (const ext of extensions) {
      const candidate = path.join(dir, `${cmd}${ext}`)
      try {
        // Check if file exists and is executable
        // On Windows, we also need to check if it's a file (not a directory)
        const stats = fs.statSync(candidate, { throwIfNoEntry: false })
        if (stats && stats.isFile()) {
          // On Windows, .cmd and .bat files need to be run via cmd.exe when shell: false
          const needsCmdWrapper =
            process.platform === "win32" && (ext === ".cmd" || ext === ".bat")
          return { cmd: candidate, needsCmdWrapper }
        }
      } catch {
        // Continue searching
      }
    }
  }

  // If not found, return original cmd (spawn will handle the error)
  return { cmd, needsCmdWrapper: false }
}
