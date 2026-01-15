import { $TASK_INTERNAL } from "./constants.js"
import type { Task } from "./types.js"

export function validateTasks(tasks?: Task[]): void {
  if (tasks?.some((dep) => !($TASK_INTERNAL in dep))) {
    throw new Error(
      "Invalid dependency: must be a task or a pipeline converted to a task"
    )
  }
}
