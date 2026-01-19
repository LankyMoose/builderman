export interface SignalHandlerConfig {
  abortSignal?: AbortSignal
  onProcessTerminated: (message: string) => void
  onAborted: () => void
}

export interface SignalHandler {
  cleanup(): void
}

/**
 * Creates a signal handler for pipeline execution.
 * Handles process termination signals (SIGINT, SIGTERM, etc.) and abort signals.
 */
export function createSignalHandler({
  abortSignal,
  onAborted,
  onProcessTerminated,
}: SignalHandlerConfig): SignalHandler {
  // Handle termination signals
  const processTerminationListenerCleanups = [
    "SIGINT",
    "SIGTERM",
    "SIGQUIT",
    "SIGBREAK",
  ].map((sig) => {
    const handleSignal = () => {
      onProcessTerminated(`Received ${sig}`)
    }
    process.once(sig, handleSignal)
    return () => {
      process.removeListener(sig, handleSignal)
    }
  })

  // Handle abort signal if provided
  let signalCleanup: (() => void) | null = null
  if (abortSignal) {
    const handleAbort = () => {
      onAborted()
    }
    abortSignal.addEventListener("abort", handleAbort)
    signalCleanup = () => {
      abortSignal.removeEventListener("abort", handleAbort)
    }
  }

  return {
    /**
     * Cleans up all signal listeners.
     */
    cleanup(): void {
      processTerminationListenerCleanups.forEach((cleanup) => cleanup())
      signalCleanup?.()
    },
  }
}
