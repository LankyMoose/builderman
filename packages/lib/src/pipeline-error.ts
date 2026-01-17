export type PipelineErrorCode =
  | typeof PipelineError.Aborted
  | typeof PipelineError.ProcessTerminated
  | typeof PipelineError.TaskFailed
  | typeof PipelineError.InvalidSignal
  | typeof PipelineError.InvalidTask

export class PipelineError extends Error {
  readonly code: PipelineErrorCode
  readonly taskName?: string
  constructor(message: string, code: PipelineErrorCode, taskName?: string) {
    super(message)
    this.name = "PipelineError"
    this.code = code
    this.taskName = taskName
  }

  static Aborted = 0 as const
  static ProcessTerminated = 1 as const
  static TaskFailed = 2 as const
  static InvalidSignal = 3 as const
  static InvalidTask = 4 as const
}
