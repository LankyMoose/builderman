import assert from "node:assert"
import { describe, it } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { pipeline } from "builderman"
import { task } from "builderman"
import { pnpm } from "../index.js"
// Import helpers from builderman package
// Note: In a real scenario, this would be imported from the built package
// For now, we'll create a simple mock spawn function
import { EventEmitter } from "node:events"
import { mock } from "node:test"
import type { ChildProcess } from "node:child_process"

function createMockSpawn() {
  return mock.fn((cmd: string, args: string[] = [], _spawnOptions?: any) => {
    const mockProcess = new EventEmitter() as ChildProcess
    mockProcess.kill = mock.fn() as any
    mockProcess.stdout = new EventEmitter() as any
    mockProcess.stderr = new EventEmitter() as any

    setImmediate(() => {
      mockProcess.emit("exit", 0)
    })

    return mockProcess
  }) as any
}

describe("pnpm resolver integration", () => {
  it("caches task based on pnpm dependencies", async () => {
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "builderman-pnpm-integration-")
    )
    const srcDir = path.join(testDir, "src")
    const distDir = path.join(testDir, "dist")

    try {
      // Set up project structure
      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(distDir, { recursive: true })

      // Create package.json with a dependency
      const packageJson = {
        name: "test-project",
        version: "1.0.0",
        dependencies: {
          lodash: "^4.17.21",
        },
      }
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      )

      // Create pnpm-lock.yaml
      const lockfile = {
        lockfileVersion: "6.0",
        importers: {
          ".": {
            dependencies: {
              lodash: "4.17.21",
            },
          },
        },
        packages: {
          "/lodash/4.17.21": {
            resolution: {
              integrity: "sha512-t2Iey9ov1L3o8nFXuXlBzqN3zY7kFkL3k5V8Q2K4J5L6M7N8O9P0Q1R2S3T4U5V6W7X8Y9Z0",
            },
          },
        },
      }
      fs.writeFileSync(
        path.join(testDir, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      // Create source file
      fs.writeFileSync(
        path.join(srcDir, "index.ts"),
        'import _ from "lodash"; export const result = _.add(1, 2);'
      )

      // Create task with pnpm resolver
      const buildTask = task({
        name: "build",
        cwd: testDir,
        commands: {
          build: {
            run: "echo 'Building...'",
            cache: {
              inputs: ["src", pnpm.package({ scope: "local" })],
              outputs: ["dist"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([buildTask])

      // First run: should execute
      const first = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(first.ok, true)
      assert.strictEqual(first.stats.summary.completed, 1)
      assert.strictEqual(first.stats.summary.skipped, 0)

      const callsAfterFirst = mockSpawn.mock.calls.length
      assert.ok(callsAfterFirst >= 1, "First run should execute the command")

      // Second run: should be cached (same dependencies)
      const second = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(second.ok, true)
      assert.strictEqual(second.stats.summary.completed, 0)
      assert.strictEqual(second.stats.summary.skipped, 1)

      const taskStats = second.stats.tasks[0]
      assert.strictEqual(taskStats.status, "skipped")
      assert.strictEqual(taskStats.cache?.hit, true)

      const callsAfterSecond = mockSpawn.mock.calls.length
      assert.strictEqual(
        callsAfterSecond,
        callsAfterFirst,
        "Second run should not execute due to cache"
      )

      // Third run: change dependency version (should invalidate cache)
      packageJson.dependencies.lodash = "^4.17.22"
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      )

      lockfile.importers["."].dependencies.lodash = "4.17.22"
      const lockfileAny = lockfile as any
      lockfileAny.packages["/lodash/4.17.22"] = {
        resolution: {
          integrity: "sha512-different-hash",
        },
      }
      delete lockfileAny.packages["/lodash/4.17.21"]
      fs.writeFileSync(
        path.join(testDir, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

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
        "Third run should execute due to dependency change"
      )

      // Fourth run: should be cached again (dependencies unchanged)
      const fourth = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(fourth.ok, true)
      assert.strictEqual(fourth.stats.summary.completed, 0)
      assert.strictEqual(fourth.stats.summary.skipped, 1)
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
      // Clean up cache
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")
      const cacheFile = path.join(cacheDir, "build-build.json")
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile)
      }
    }
  })

  it("works with workspace packages", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "builderman-pnpm-workspace-integration-")
    )
    const packageDir = path.join(workspaceRoot, "packages", "my-app")
    const srcDir = path.join(packageDir, "src")
    const distDir = path.join(packageDir, "dist")

    try {
      // Set up workspace structure
      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(distDir, { recursive: true })

      // Create workspace files
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'"
      )

      const rootPackageJson = {
        name: "workspace-root",
        version: "1.0.0",
      }
      fs.writeFileSync(
        path.join(workspaceRoot, "package.json"),
        JSON.stringify(rootPackageJson, null, 2)
      )

      // Create package.json in workspace package
      const packageJson = {
        name: "my-app",
        version: "1.0.0",
        dependencies: {
          express: "^4.18.0",
        },
      }
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      )

      // Create pnpm-lock.yaml in workspace root
      const lockfile = {
        lockfileVersion: "6.0",
        importers: {
          ".": {},
          "packages/my-app": {
            dependencies: {
              express: "4.18.0",
            },
          },
        },
        packages: {
          "/express/4.18.0": {
            resolution: {
              integrity: "sha512-express-hash",
            },
          },
        },
      }
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      // Create source file
      fs.writeFileSync(
        path.join(srcDir, "index.ts"),
        'import express from "express"; const app = express();'
      )

      // Create task with workspace pnpm resolver
      const buildTask = task({
        name: "build-app",
        cwd: packageDir,
        commands: {
          build: {
            run: "echo 'Building app...'",
            cache: {
              inputs: ["src", pnpm.package({ scope: "workspace" })],
              outputs: ["dist"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([buildTask])

      // First run: should execute
      const first = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(first.ok, true)
      assert.strictEqual(first.stats.summary.completed, 1)

      // Second run: should be cached
      const second = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(second.ok, true)
      assert.strictEqual(second.stats.summary.skipped, 1)
      assert.strictEqual(second.stats.tasks[0].cache?.hit, true)

      // Change dependency in workspace package (should invalidate)
      packageJson.dependencies.express = "^4.19.0"
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      )

      lockfile.importers["packages/my-app"].dependencies.express = "4.19.0"
      const lockfileAny = lockfile as any
      lockfileAny.packages["/express/4.19.0"] = {
        resolution: {
          integrity: "sha512-express-new-hash",
        },
      }
      delete lockfileAny.packages["/express/4.18.0"]
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      const third = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(third.ok, true)
      assert.strictEqual(third.stats.summary.completed, 1)
      assert.strictEqual(third.stats.summary.skipped, 0)
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
      // Clean up cache
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")
      const cacheFile = path.join(cacheDir, "build-app-build.json")
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile)
      }
    }
  })

  it("does not invalidate when unrelated workspace package changes", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "builderman-pnpm-workspace-isolation-")
    )
    const packageADir = path.join(workspaceRoot, "packages", "package-a")
    const packageBDir = path.join(workspaceRoot, "packages", "package-b")
    const srcDirA = path.join(packageADir, "src")
    const distDirA = path.join(packageADir, "dist")

    try {
      // Set up workspace structure
      fs.mkdirSync(srcDirA, { recursive: true })
      fs.mkdirSync(distDirA, { recursive: true })
      fs.mkdirSync(packageBDir, { recursive: true })

      // Create workspace files
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'"
      )

      const rootPackageJson = {
        name: "workspace-root",
        version: "1.0.0",
      }
      fs.writeFileSync(
        path.join(workspaceRoot, "package.json"),
        JSON.stringify(rootPackageJson, null, 2)
      )

      // Package A depends on lodash
      const packageAJson = {
        name: "package-a",
        version: "1.0.0",
        dependencies: {
          lodash: "^4.17.21",
        },
      }
      fs.writeFileSync(
        path.join(packageADir, "package.json"),
        JSON.stringify(packageAJson, null, 2)
      )

      // Package B depends on express
      const packageBJson = {
        name: "package-b",
        version: "1.0.0",
        dependencies: {
          express: "^4.18.0",
        },
      }
      fs.writeFileSync(
        path.join(packageBDir, "package.json"),
        JSON.stringify(packageBJson, null, 2)
      )

      // Create lockfile with both packages
      const lockfile = {
        lockfileVersion: "6.0",
        importers: {
          ".": {},
          "packages/package-a": {
            dependencies: {
              lodash: "4.17.21",
            },
          },
          "packages/package-b": {
            dependencies: {
              express: "4.18.0",
            },
          },
        },
        packages: {
          "/lodash/4.17.21": {
            resolution: {
              integrity: "sha512-lodash-hash",
            },
          },
          "/express/4.18.0": {
            resolution: {
              integrity: "sha512-express-hash",
            },
          },
        },
      }
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      // Create source file for package A
      fs.writeFileSync(
        path.join(srcDirA, "index.ts"),
        'import _ from "lodash"; export const result = _.add(1, 2);'
      )

      // Create task for package A
      const buildTaskA = task({
        name: "build-package-a",
        cwd: packageADir,
        commands: {
          build: {
            run: "echo 'Building package A...'",
            cache: {
              inputs: ["src", pnpm.package({ scope: "workspace" })],
              outputs: ["dist"],
            },
          },
        },
      })

      const mockSpawn = createMockSpawn()
      const pipe = pipeline([buildTaskA])

      // First run: should execute
      const first = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(first.ok, true)
      assert.strictEqual(first.stats.summary.completed, 1)

      // Second run: should be cached
      const second = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(second.ok, true)
      assert.strictEqual(second.stats.summary.skipped, 1)
      const callsAfterSecond = mockSpawn.mock.calls.length

      // Change package B's dependency (should NOT affect package A's cache)
      packageBJson.dependencies.express = "^4.19.0"
      fs.writeFileSync(
        path.join(packageBDir, "package.json"),
        JSON.stringify(packageBJson, null, 2)
      )

      lockfile.importers["packages/package-b"].dependencies.express = "4.19.0"
      const lockfileAnyB = lockfile as any
      lockfileAnyB.packages["/express/4.19.0"] = {
        resolution: {
          integrity: "sha512-express-new-hash",
        },
      }
      delete lockfileAnyB.packages["/express/4.18.0"]
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      const third = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      // Package A should still be cached (package B changes don't affect it)
      assert.strictEqual(third.ok, true)
      assert.strictEqual(third.stats.summary.skipped, 1)
      assert.strictEqual(third.stats.tasks[0].cache?.hit, true)

      const callsAfterThird = mockSpawn.mock.calls.length
      assert.strictEqual(
        callsAfterThird,
        callsAfterSecond,
        "Package A should remain cached when package B changes"
      )

      // Change package A's dependency (should invalidate)
      packageAJson.dependencies.lodash = "^4.17.22"
      fs.writeFileSync(
        path.join(packageADir, "package.json"),
        JSON.stringify(packageAJson, null, 2)
      )

      lockfile.importers["packages/package-a"].dependencies.lodash = "4.17.22"
      const lockfileAnyA = lockfile as any
      lockfileAnyA.packages["/lodash/4.17.22"] = {
        resolution: {
          integrity: "sha512-lodash-new-hash",
        },
      }
      delete lockfileAnyA.packages["/lodash/4.17.21"]
      fs.writeFileSync(
        path.join(workspaceRoot, "pnpm-lock.yaml"),
        JSON.stringify(lockfile, null, 2)
      )

      const fourth = await pipe.run({
        command: "build",
        spawn: mockSpawn as any,
      })

      assert.strictEqual(fourth.ok, true)
      assert.strictEqual(fourth.stats.summary.completed, 1)
      assert.strictEqual(fourth.stats.summary.skipped, 0)
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
      // Clean up cache
      const cacheDir = path.join(process.cwd(), ".builderman", "cache", "v1")
      const cacheFile = path.join(cacheDir, "build-package-a-build.json")
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile)
      }
    }
  })
})
