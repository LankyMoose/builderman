// Long-running script used to test pipeline cancellation of real processes.
// It keeps the event loop alive until it is terminated by a signal.
console.log("LONG_RUNNING_START")

const interval = setInterval(() => {
  // Periodic output so we can see it's still alive if not killed.
  console.log("LONG_RUNNING_TICK")
}, 100)

const cleanupAndExit = () => {
  clearInterval(interval)
  console.log("LONG_RUNNING_EXIT")
  process.exit(0)
}

// Ensure we exit quickly when the process is terminated by a signal.
process.on("SIGTERM", cleanupAndExit)
process.on("SIGINT", cleanupAndExit)
process.on("SIGBREAK", cleanupAndExit)
