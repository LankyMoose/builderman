import assert from "node:assert"
import { describe, it } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { pipeline } from "../pipeline.js"
import { task } from "../task.js"
import { createMockSpawn } from "./helpers.js"

describe("cache", () => {
  describe("cache behavior", () => {
    it("skips task when cache snapshot matches", async () => {
      // Create a temporary directory for this test
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-cache-test-")
      )
      const inputDir = path.join(testDir, "src")
      const outputDir = path.join(testDir, "dist")
      // Cache is stored relative to process.cwd(), not task cwd
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")

      try {
        // Set up test directories and files
        fs.mkdirSync(inputDir, { recursive: true })
        fs.mkdirSync(outputDir, { recursive: true })
        fs.writeFileSync(path.join(inputDir, "file.ts"), "export const a = 1")

        const task1 = task({
          name: "cached-task",
          cwd: testDir,
          commands: {
            build: {
              run: "echo build",
              cache: {
                inputs: ["src"],
                outputs: ["dist"],
              },
            },
          },
        })

        const mockSpawn = createMockSpawn()
        const pipe = pipeline([task1])

        // First run: no cache, command should execute
        const first = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(first.ok, true)
        assert.strictEqual(first.stats.summary.completed, 1)

        const callsAfterFirst = mockSpawn.mock.calls.length
        assert.ok(callsAfterFirst >= 1, "First run should spawn the command")

        // Second run: cache should match and task should be skipped
        const second = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })

        assert.strictEqual(second.ok, true)
        const taskStats = second.stats.tasks[0]
        assert.strictEqual(taskStats.status, "skipped")
        assert.strictEqual(second.stats.summary.skipped, 1)

        const callsAfterSecond = mockSpawn.mock.calls.length
        assert.strictEqual(
          callsAfterSecond,
          callsAfterFirst,
          "Second run should not spawn the command due to cache"
        )
      } finally {
        // Clean up test directory and cache file
        fs.rmSync(testDir, { recursive: true, force: true })
        const cacheFile = path.join(cacheDir, "cached-task-build.json")
        if (fs.existsSync(cacheFile)) {
          fs.unlinkSync(cacheFile)
        }
      }
    })

    it("writes cache snapshot after task completion", async () => {
      // Create a temporary directory for this test
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "builderman-test-"))
      const inputDir = path.join(testDir, "src")
      const outputDir = path.join(testDir, "dist")
      // Cache is stored relative to process.cwd(), not task cwd
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")

      try {
        // Set up test directories and files
        fs.mkdirSync(inputDir, { recursive: true })
        fs.mkdirSync(outputDir, { recursive: true })
        fs.writeFileSync(path.join(inputDir, "file1.ts"), "export const a = 1")
        fs.writeFileSync(path.join(inputDir, "file2.ts"), "export const b = 2")

        const task1 = task({
          name: "cache-test-task",
          cwd: testDir,
          commands: {
            build: {
              run: "echo build",
              cache: {
                inputs: ["src"],
                outputs: ["dist"],
              },
            },
          },
        })

        const mockSpawn = createMockSpawn()
        const pipe = pipeline([task1])

        // First run: should execute and create cache file
        const first = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(first.ok, true)
        assert.strictEqual(first.stats.summary.completed, 1)
        assert.strictEqual(first.stats.summary.skipped, 0)

        const callsAfterFirst = mockSpawn.mock.calls.length
        assert.ok(callsAfterFirst >= 1, "First run should spawn the command")

        // Verify cache file was created after completion
        const cacheFile = path.join(cacheDir, "cache-test-task-build.json")
        assert.ok(
          fs.existsSync(cacheFile),
          "Cache file should exist after first run completes"
        )

        // Verify cache file contains valid snapshot
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
        assert.strictEqual(cacheData.version, 1)
        assert.strictEqual(cacheData.cwd, testDir)
        assert.ok(Array.isArray(cacheData.inputs))
        assert.ok(Array.isArray(cacheData.outputs))
        assert.ok(cacheData.inputs.length > 0, "Should have input files")
        assert.ok(
          cacheData.outputs.length >= 0,
          "Should have output files (may be empty)"
        )

        // Second run: should be skipped due to cache hit
        const second = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(second.ok, true)
        assert.strictEqual(second.stats.summary.completed, 0)
        assert.strictEqual(second.stats.summary.skipped, 1)

        const callsAfterSecond = mockSpawn.mock.calls.length
        assert.strictEqual(
          callsAfterSecond,
          callsAfterFirst,
          "Second run should not spawn the command due to cache"
        )

        // Modify an input file to cause cache miss
        await new Promise((resolve) => setTimeout(resolve, 10)) // Small delay to ensure different mtime
        fs.writeFileSync(path.join(inputDir, "file1.ts"), "export const a = 2")

        // Third run: should execute due to cache miss
        const third = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(third.ok, true)
        assert.strictEqual(third.stats.summary.completed, 1)
        assert.strictEqual(third.stats.summary.skipped, 0)

        const callsAfterThird = mockSpawn.mock.calls.length
        assert.ok(
          callsAfterThird > callsAfterSecond,
          "Third run should spawn the command due to cache miss"
        )

        // Fourth run: should be skipped again (cache hit)
        const fourth = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(fourth.ok, true)
        assert.strictEqual(fourth.stats.summary.completed, 0)
        assert.strictEqual(fourth.stats.summary.skipped, 1)

        const callsAfterFourth = mockSpawn.mock.calls.length
        assert.strictEqual(
          callsAfterFourth,
          callsAfterThird,
          "Fourth run should not spawn the command due to cache"
        )
      } finally {
        // Clean up test directory and cache file
        fs.rmSync(testDir, { recursive: true, force: true })
        const cacheFile = path.join(cacheDir, "cache-test-task-build.json")
        if (fs.existsSync(cacheFile)) {
          fs.unlinkSync(cacheFile)
        }
      }
    })

    it("works with input-only caching (no outputs)", async () => {
      // Create a temporary directory for this test
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-input-only-cache-")
      )
      const inputDir = path.join(testDir, "src")
      // Cache is stored relative to process.cwd(), not task cwd
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")

      try {
        // Set up test directories and files
        fs.mkdirSync(inputDir, { recursive: true })
        fs.writeFileSync(path.join(inputDir, "file.ts"), "export const a = 1")

        const task1 = task({
          name: "input-only-cache-task",
          cwd: testDir,
          commands: {
            build: {
              run: "echo build",
              cache: {
                inputs: ["src"],
                // outputs not specified - input-only caching
              },
            },
          },
        })

        const mockSpawn = createMockSpawn()
        const pipe = pipeline([task1])

        // First run: should execute and create cache file
        const first = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(first.ok, true)
        assert.strictEqual(first.stats.summary.completed, 1)
        assert.strictEqual(first.stats.summary.skipped, 0)

        const callsAfterFirst = mockSpawn.mock.calls.length
        assert.ok(callsAfterFirst >= 1, "First run should spawn the command")

        // Verify cache file was created
        const cacheFile = path.join(
          cacheDir,
          "input-only-cache-task-build.json"
        )
        assert.ok(
          fs.existsSync(cacheFile),
          "Cache file should exist after first run completes"
        )

        // Verify cache file contains valid snapshot with empty outputs
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
        assert.strictEqual(cacheData.version, 1)
        assert.strictEqual(cacheData.cwd, testDir)
        assert.ok(Array.isArray(cacheData.inputs))
        assert.ok(Array.isArray(cacheData.outputs))
        assert.ok(cacheData.inputs.length > 0, "Should have input files")
        assert.strictEqual(
          cacheData.outputs.length,
          0,
          "Should have no output files when outputs not configured"
        )

        // Verify task stats show empty outputs
        const firstTaskStats = first.stats.tasks[0]
        assert.ok(firstTaskStats.cache !== undefined)
        assert.strictEqual(firstTaskStats.cache.inputs.length, 1)
        assert.strictEqual(firstTaskStats.cache.inputs[0], "src")
        assert.strictEqual(
          firstTaskStats.cache.outputs.length,
          0,
          "Outputs should be empty when not configured"
        )

        // Second run: should be skipped due to cache hit
        const second = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(second.ok, true)
        assert.strictEqual(second.stats.summary.completed, 0)
        assert.strictEqual(second.stats.summary.skipped, 1)

        const callsAfterSecond = mockSpawn.mock.calls.length
        assert.strictEqual(
          callsAfterSecond,
          callsAfterFirst,
          "Second run should not spawn the command due to cache"
        )

        // Modify an input file to cause cache miss
        await new Promise((resolve) => setTimeout(resolve, 10)) // Small delay to ensure different mtime
        fs.writeFileSync(path.join(inputDir, "file.ts"), "export const a = 2")

        // Third run: should execute due to cache miss
        const third = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(third.ok, true)
        assert.strictEqual(third.stats.summary.completed, 1)
        assert.strictEqual(third.stats.summary.skipped, 0)

        const callsAfterThird = mockSpawn.mock.calls.length
        assert.ok(
          callsAfterThird > callsAfterSecond,
          "Third run should spawn the command due to cache miss"
        )

        // Fourth run: should be skipped again (cache hit)
        const fourth = await pipe.run({
          command: "build",
          spawn: mockSpawn as any,
        })
        assert.strictEqual(fourth.ok, true)
        assert.strictEqual(fourth.stats.summary.completed, 0)
        assert.strictEqual(fourth.stats.summary.skipped, 1)

        const callsAfterFourth = mockSpawn.mock.calls.length
        assert.strictEqual(
          callsAfterFourth,
          callsAfterThird,
          "Fourth run should not spawn the command due to cache"
        )
      } finally {
        // Clean up test directory and cache file
        fs.rmSync(testDir, { recursive: true, force: true })
        const cacheFile = path.join(cacheDir, "input-only-cache-task-build.json")
        if (fs.existsSync(cacheFile)) {
          fs.unlinkSync(cacheFile)
        }
      }
    })
  })

  describe("cache stats", () => {
    it("includes cache info when task has cache configuration", async () => {
      const task1 = task({
        name: "cached-task",
        commands: {
          build: {
            run: "echo build",
            cache: {
              inputs: ["src"],
              outputs: ["dist"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      const taskStats = result.stats.tasks[0]

      // Cache info should be present
      assert.ok(taskStats.cache !== undefined, "Cache info should be present")
      assert.strictEqual(typeof taskStats.cache.checked, "boolean")
      assert.strictEqual(typeof taskStats.cache.hit, "boolean")
      assert.strictEqual(typeof taskStats.cache.cacheFile, "string")
      assert.ok(Array.isArray(taskStats.cache.inputs))
      assert.ok(Array.isArray(taskStats.cache.outputs))

      // First run should check cache but miss (no previous cache)
      assert.strictEqual(taskStats.cache.checked, true)
      assert.strictEqual(taskStats.cache.hit, false)
      assert.ok(taskStats.cache.cacheFile.length > 0)
      assert.strictEqual(taskStats.cache.inputs.length, 1)
      assert.strictEqual(taskStats.cache.inputs[0], "src")
      assert.strictEqual(taskStats.cache.outputs.length, 1)
      assert.strictEqual(taskStats.cache.outputs[0], "dist")
    })

    it("shows cache hit when task is skipped due to cache", async () => {
      const task1 = task({
        name: "cached-task",
        commands: {
          build: {
            run: "echo build",
            cache: {
              inputs: ["src"],
              outputs: ["dist"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])

      // First run: creates cache
      await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      // Second run: should hit cache
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.stats.summary.skipped, 1)

      const taskStats = result.stats.tasks[0]
      assert.strictEqual(taskStats.status, "skipped")

      // Cache info should show hit
      assert.ok(taskStats.cache !== undefined)
      assert.strictEqual(taskStats.cache.checked, true)
      assert.strictEqual(taskStats.cache.hit, true)
      assert.strictEqual(typeof taskStats.cache.cacheFile, "string")
      assert.ok(Array.isArray(taskStats.cache.inputs))
      assert.ok(Array.isArray(taskStats.cache.outputs))
    })

    it("does not include cache info when task has no cache configuration", async () => {
      const task1 = task({
        name: "regular-task",
        commands: {
          build: "echo build",
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      const taskStats = result.stats.tasks[0]

      // Cache info should NOT be present
      assert.strictEqual(taskStats.cache, undefined)
    })

    it("includes cache info with multiple input/output paths", async () => {
      const task1 = task({
        name: "multi-path-cache",
        commands: {
          build: {
            run: "echo build",
            cache: {
              inputs: ["src", "config"],
              outputs: ["dist", "build"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([task1])
      const result = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(result.ok, true)
      const taskStats = result.stats.tasks[0]

      assert.ok(taskStats.cache !== undefined)
      assert.ok(Array.isArray(taskStats.cache.inputs))
      assert.ok(Array.isArray(taskStats.cache.outputs))
      assert.strictEqual(taskStats.cache.inputs.length, 2)
      assert.strictEqual(taskStats.cache.outputs.length, 2)
      assert.ok(taskStats.cache!.inputs.includes("src"))
      assert.ok(taskStats.cache.inputs.includes("config"))
      assert.ok(taskStats.cache.outputs.includes("dist"))
      assert.ok(taskStats.cache.outputs.includes("build"))
    })
  })
})
