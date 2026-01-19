/**
 * Centralized timeout management for task execution
 * Handles readyWhen and completion timeouts with proper cleanup
 */
export interface TimeoutManager {
  /**
   * Set a timeout for a task's readyWhen condition
   */
  setReadyTimeout(taskId: string, timeout: number, callback: () => void): void

  /**
   * Set a timeout for a task's completion
   */
  setCompletionTimeout(
    taskId: string,
    timeout: number,
    callback: () => void
  ): void

  /**
   * Clear the ready timeout for a specific task
   */
  clearReadyTimeout(taskId: string): void

  /**
   * Clear the completion timeout for a specific task
   */
  clearCompletionTimeout(taskId: string): void

  /**
   * Clear all timeouts for a specific task
   */
  clearTaskTimeouts(taskId: string): void

  /**
   * Clear all timeouts (used during cancellation)
   */
  clearAllTimeouts(): void
}

/**
 * Creates a timeout manager for task execution
 */
export function createTimeoutManager(): TimeoutManager {
  const readyTimeouts: Map<string, NodeJS.Timeout> = new Map()
  const completionTimeouts: Map<string, NodeJS.Timeout> = new Map()

  return {
    /**
     * Set a timeout for a task's readyWhen condition
     */
    setReadyTimeout(
      taskId: string,
      timeout: number,
      callback: () => void
    ): void {
      // Clear any existing ready timeout for this task
      const timeoutId = readyTimeouts.get(taskId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        readyTimeouts.delete(taskId)
      }

      const newTimeoutId = setTimeout(callback, timeout)
      readyTimeouts.set(taskId, newTimeoutId)
    },

    /**
     * Set a timeout for a task's completion
     */
    setCompletionTimeout(
      taskId: string,
      timeout: number,
      callback: () => void
    ): void {
      // Clear any existing completion timeout for this task
      const timeoutId = completionTimeouts.get(taskId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        completionTimeouts.delete(taskId)
      }

      const newTimeoutId = setTimeout(callback, timeout)
      completionTimeouts.set(taskId, newTimeoutId)
    },

    /**
     * Clear the ready timeout for a specific task
     */
    clearReadyTimeout(taskId: string): void {
      const timeoutId = readyTimeouts.get(taskId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        readyTimeouts.delete(taskId)
      }
    },

    /**
     * Clear the completion timeout for a specific task
     */
    clearCompletionTimeout(taskId: string): void {
      const timeoutId = completionTimeouts.get(taskId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        completionTimeouts.delete(taskId)
      }
    },

    /**
     * Clear all timeouts for a specific task
     */
    clearTaskTimeouts(taskId: string): void {
      const readyTimeoutId = readyTimeouts.get(taskId)
      if (readyTimeoutId) {
        clearTimeout(readyTimeoutId)
        readyTimeouts.delete(taskId)
      }

      const completionTimeoutId = completionTimeouts.get(taskId)
      if (completionTimeoutId) {
        clearTimeout(completionTimeoutId)
        completionTimeouts.delete(taskId)
      }
    },

    /**
     * Clear all timeouts (used during cancellation)
     */
    clearAllTimeouts(): void {
      // Clear all ready timeouts
      for (const timeoutId of readyTimeouts.values()) {
        clearTimeout(timeoutId)
      }
      readyTimeouts.clear()

      // Clear all completion timeouts
      for (const timeoutId of completionTimeouts.values()) {
        clearTimeout(timeoutId)
      }
      completionTimeouts.clear()
    },
  }
}
