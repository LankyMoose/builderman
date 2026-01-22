import { $TASK_INTERNAL, $PIPELINE_INTERNAL } from "./internal/constants.js"
import { validateTasks } from "./internal/util.js"
import { createRunContext, runPipeline } from "./internal/run-context.js"
import { task } from "./task.js"

import type { Pipeline, Task } from "./types.js"

/**
 * Creates a pipeline that manages task execution with dependency-based coordination.
 * @param tasks - The tasks to include in the pipeline.
 * @returns A pipeline that can be used to execute the tasks.
 * @example
 * const task1 = task({ name: "task1", commands: { dev: "echo task1" }, cwd: "." })
 * const task2 = task({ name: "task2", commands: { dev: "echo task2" }, cwd: ".", dependencies: [task1] })
 * await pipeline([task1, task2]).run()
 */
export function pipeline(tasks: Task[]): Pipeline {
  const tasksClone = [...tasks]
  validateTasks(tasksClone)

  const pipelineImpl: Pipeline = {
    [$PIPELINE_INTERNAL]: {
      tasks: tasksClone,
    },

    toTask({ name, dependencies, env }): Task {
      const dependenciesClone = [...(dependencies || [])]
      validateTasks(dependenciesClone)

      // For nested pipelines, we still support task-level dependencies
      // since the synthetic task has no commands. These will be used
      // when the nested pipeline task is used as a dependency.
      const syntheticTask = task({
        name,
        commands: {},
        env,
        dependencies: dependenciesClone,
      })

      // Mark this task as a pipeline task so it can be detected by the executor
      syntheticTask[$TASK_INTERNAL].pipeline = pipelineImpl

      return syntheticTask
    },

    async run(config) {
      const ctx = createRunContext(tasksClone, config)
      return runPipeline(ctx)
    },
  }

  return pipelineImpl
}
