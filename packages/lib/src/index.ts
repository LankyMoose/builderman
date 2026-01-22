export { task } from "./task.js"
export { pipeline } from "./pipeline.js"
export { PipelineError, type PipelineErrorCode } from "./errors.js"
export * from "./resolvers/index.js"

export type {
  Task,
  Pipeline,
  TaskConfig,
  Command,
  CommandConfig,
  Commands,
  PipelineRunConfig,
  PipelineTaskConfig,
  RunResult,
  PipelineStats,
  TaskStats,
  TaskStatus,
} from "./types.js"

export type {
  InputResolver,
  ResolveContext,
  ResolvedInput,
} from "./resolvers/types.js"
