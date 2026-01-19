import assert from "node:assert"
import { describe, it } from "node:test"

import { createSignalHandler } from "../internal/signal-handler.js"

describe("createSignalHandler", () => {
  it("registers process termination listeners and calls onProcessTerminated", () => {
    const originalOnce = process.once
    const originalRemoveListener = process.removeListener

    const signals: Array<NodeJS.Signals> = [
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGBREAK",
    ]

    const registered: Record<string, Array<() => void>> = {}
    const removed: Array<{
      event: string | symbol
      handler: (...args: any[]) => void
    }> = []

    // Stub process.once/removeListener so we don't attach real OS signal handlers
    ;(process.once as any) = (
      event: string | symbol,
      handler: (...args: any[]) => void
    ) => {
      const key = String(event)
      if (!registered[key]) registered[key] = []
      registered[key].push(handler)
      return process
    }
    ;(process.removeListener as any) = (
      event: string | symbol,
      handler: (...args: any[]) => void
    ) => {
      removed.push({ event, handler })
      return process
    }

    const messages: string[] = []

    try {
      const handler = createSignalHandler({
        onProcessTerminated: (message) => {
          messages.push(message)
        },
        onAborted: () => {
          // not used in this test
        },
      })

      // One listener should be registered for each signal
      for (const sig of signals) {
        assert.ok(
          registered[sig] && registered[sig].length === 1,
          `Expected one handler registered for ${sig}`
        )
      }

      // Simulate a signal by invoking the stored handler
      const sig = "SIGINT"
      registered[sig][0]()

      assert.strictEqual(messages.length, 1)
      assert.strictEqual(messages[0], `Received ${sig}`)

      // Cleanup should remove all registered listeners
      handler.cleanup()

      for (const sigName of signals) {
        const sigHandlers = registered[sigName] ?? []
        for (const h of sigHandlers) {
          const wasRemoved = removed.some(
            (entry) => entry.event === sigName && entry.handler === h
          )
          assert.ok(
            wasRemoved,
            `Expected handler for ${sigName} to be removed on cleanup`
          )
        }
      }
    } finally {
      // Restore original process methods
      process.once = originalOnce
      process.removeListener = originalRemoveListener
    }
  })

  it("subscribes to AbortSignal and calls onAborted, then cleans up", () => {
    const controller = new AbortController()
    const signal = controller.signal

    const addedListeners: Array<() => void> = []
    const removedListeners: Array<() => void> = []

    const originalAddEventListener = signal.addEventListener
    const originalRemoveEventListener = signal.removeEventListener

    ;(signal.addEventListener as any) = (
      _type: string,
      listener: () => void
    ) => {
      addedListeners.push(listener)
      return originalAddEventListener.call(signal, _type, listener as any)
    }
    ;(signal.removeEventListener as any) = (
      _type: string,
      listener: () => void
    ) => {
      removedListeners.push(listener)
      return originalRemoveEventListener.call(signal, _type, listener as any)
    }

    let abortedCalled = 0

    const handler = createSignalHandler({
      abortSignal: signal,
      onAborted: () => {
        abortedCalled++
      },
      onProcessTerminated: () => {
        // not used here
      },
    })

    // Exactly one abort listener should have been added
    assert.strictEqual(addedListeners.length, 1)

    // Trigger abort and verify callback is invoked
    controller.abort()
    assert.strictEqual(abortedCalled, 1)

    // Cleanup should remove the abort listener
    handler.cleanup()
    assert.strictEqual(removedListeners.length, 1)
    assert.strictEqual(removedListeners[0], addedListeners[0])
  })
})
