export type PipelineErrorCode =
  | typeof PipelineError.Aborted
  | typeof PipelineError.ProcessTerminated
  | typeof PipelineError.TaskFailed
  | typeof PipelineError.TaskCompletedTimeout
  | typeof PipelineError.TaskReadyTimeout
  | typeof PipelineError.InvalidTask
  | typeof PipelineError.InvalidGraph

export class PipelineError extends Error {
  readonly code: PipelineErrorCode
  readonly taskName?: string
  constructor(message: string, code: PipelineErrorCode, taskName?: string) {
    super(message)
    this.name = "PipelineError"
    this.code = code
    this.taskName = taskName
  }

  static Aborted = "aborted" as const
  static ProcessTerminated = "process-terminated" as const
  static TaskFailed = "task-failed" as const
  static TaskReadyTimeout = "task-ready-timeout" as const
  static TaskCompletedTimeout = "task-completed-timeout" as const
  static InvalidTask = "invalid-task" as const
  static InvalidGraph = "invalid-graph" as const
}
