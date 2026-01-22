import assert from "node:assert"
import { describe, it } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { pnpm } from "../index.js"
import type { ResolveContext } from "builderman"

describe("pnpm resolver", () => {
  describe("local scope", () => {
    it("resolves dependencies for local package", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        // Create package.json
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        // Create pnpm-lock.yaml (JSON format)
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
                integrity: "sha512-...",
              },
            },
          },
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved = resolver.resolve(ctx)

        assert.strictEqual(resolved.length, 2)
        assert.strictEqual(resolved[0].type, "virtual")
        if (resolved[0].type === "virtual") {
          assert.strictEqual(resolved[0].kind, "pnpm-deps")
          assert.ok(resolved[0].hash.length > 0)
          assert.ok(resolved[0].description.includes("test-package"))
        }
        assert.strictEqual(resolved[1].type, "file")
        if (resolved[1].type === "file") {
          assert.strictEqual(resolved[1].path, "package.json")
        }
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it("throws error when pnpm-lock.yaml is missing", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        assert.throws(
          () => resolver.resolve(ctx),
          /No pnpm-lock.yaml found in task directory/
        )
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it("throws error when package.json is missing", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        assert.throws(
          () => resolver.resolve(ctx),
          /No package.json found in task directory/
        )
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe("workspace scope", () => {
    it("resolves dependencies for workspace package", () => {
      const workspaceRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-workspace-")
      )
      const packageDir = path.join(workspaceRoot, "packages", "my-package")

      try {
        // Create workspace structure
        fs.mkdirSync(packageDir, { recursive: true })

        // Create pnpm-workspace.yaml
        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'"
        )

        // Create package.json in workspace root
        const rootPackageJson = {
          name: "workspace-root",
          version: "1.0.0",
        }
        fs.writeFileSync(
          path.join(workspaceRoot, "package.json"),
          JSON.stringify(rootPackageJson, null, 2)
        )

        // Create package.json in package
        const packageJson = {
          name: "my-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
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
            "packages/my-package": {
              dependencies: {
                lodash: "4.17.21",
              },
            },
          },
          packages: {
            "/lodash/4.17.21": {
              resolution: {
                integrity: "sha512-...",
              },
            },
          },
        }
        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package({ scope: "workspace" })
        const ctx: ResolveContext = {
          taskCwd: packageDir,
          rootCwd: workspaceRoot,
        }

        const resolved = resolver.resolve(ctx)

        assert.strictEqual(resolved.length, 2)
        assert.strictEqual(resolved[0].type, "virtual")
        if (resolved[0].type === "virtual") {
          assert.strictEqual(resolved[0].kind, "pnpm-deps")
          assert.ok(resolved[0].hash.length > 0)
          assert.ok(resolved[0].description.includes("my-package"))
        }
        assert.strictEqual(resolved[1].type, "file")
        if (resolved[1].type === "file") {
          assert.strictEqual(resolved[1].path, "package.json")
        }
      } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true })
      }
    })

    it("throws error when workspace root is not found", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        const resolver = pnpm.package({ scope: "workspace" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        // When workspace root is not found, it will try to use rootCwd as workspace root
        // and fail when looking for pnpm-lock.yaml there
        assert.throws(
          () => resolver.resolve(ctx),
          /Cannot find pnpm workspace root|pnpm-lock.yaml not found/
        )
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe("auto-detection", () => {
    it("auto-detects local scope when no workspace found", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        const lockfile = {
          lockfileVersion: "6.0",
          importers: {
            ".": {
              dependencies: {
                lodash: "4.17.21",
              },
            },
          },
          packages: {},
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package() // Auto-detect
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved = resolver.resolve(ctx)
        assert.strictEqual(resolved.length, 2)
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it("auto-detects workspace scope when workspace found", () => {
      const workspaceRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-workspace-")
      )
      const packageDir = path.join(workspaceRoot, "packages", "my-package")

      try {
        fs.mkdirSync(packageDir, { recursive: true })

        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'"
        )

        const packageJson = {
          name: "my-package",
          version: "1.0.0",
        }
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        const lockfile = {
          lockfileVersion: "6.0",
          importers: {
            ".": {},
            "packages/my-package": {},
          },
          packages: {},
        }
        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package() // Auto-detect
        const ctx: ResolveContext = {
          taskCwd: packageDir,
          rootCwd: workspaceRoot,
        }

        const resolved = resolver.resolve(ctx)
        assert.strictEqual(resolved.length, 2)
      } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true })
      }
    })
  })

  describe("YAML lockfile parsing", () => {
    it("parses YAML format lockfile", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        // Create YAML format lockfile
        const yamlLockfile = `lockfileVersion: '6.0'
importers:
  '.':
    dependencies:
      lodash: 4.17.21
packages:
  /lodash/4.17.21:
    resolution:
      integrity: sha512-...
`
        fs.writeFileSync(path.join(testDir, "pnpm-lock.yaml"), yamlLockfile)

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved = resolver.resolve(ctx)
        assert.strictEqual(resolved.length, 2)
        assert.strictEqual(resolved[0].type, "virtual")
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it("handles invalid lockfile gracefully", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        // Create invalid lockfile
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          "invalid: yaml: content: ["
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        assert.throws(
          () => resolver.resolve(ctx),
          /Failed to parse pnpm-lock.yaml/
        )
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe("dependency closure extraction", () => {
    it("extracts only package-specific dependencies", () => {
      const workspaceRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-workspace-")
      )
      const packageDir = path.join(workspaceRoot, "packages", "package-a")

      try {
        fs.mkdirSync(packageDir, { recursive: true })

        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'"
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
          path.join(packageDir, "package.json"),
          JSON.stringify(packageAJson, null, 2)
        )

        // Lockfile has dependencies for multiple packages
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
            "/lodash/4.17.21": {},
            "/express/4.18.0": {},
          },
        }
        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package({ scope: "workspace" })
        const ctx: ResolveContext = {
          taskCwd: packageDir,
          rootCwd: workspaceRoot,
        }

        const resolved = resolver.resolve(ctx)
        assert.strictEqual(resolved.length, 2)

        // Hash should only include package-a's dependencies, not package-b's
        const hash1 = (resolved[0] as any).hash

        // Change package-b's dependencies (should not affect package-a's hash)
        lockfile.importers["packages/package-b"].dependencies.express = "4.19.0"
        fs.writeFileSync(
          path.join(workspaceRoot, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolved2 = resolver.resolve(ctx)
        const hash2 = (resolved2[0] as any).hash

        // Hashes should be the same (package-b changes don't affect package-a)
        assert.strictEqual(hash1, hash2)
      } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true })
      }
    })

    it("includes transitive dependencies in closure", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            "package-a": "^1.0.0",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

        const lockfile = {
          lockfileVersion: "6.0",
          importers: {
            ".": {
              dependencies: {
                "package-a": "1.0.0",
              },
            },
          },
          packages: {
            "/package-a/1.0.0": {
              name: "package-a",
              dependencies: {
                "package-b": "2.0.0",
              },
            },
            "/package-b/2.0.0": {
              name: "package-b",
            },
          },
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved = resolver.resolve(ctx)
        assert.strictEqual(resolved.length, 2)
        // Hash should include both package-a and package-b
        assert.ok((resolved[0] as any).hash.length > 0)
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe("deterministic hashing", () => {
    it("produces same hash for same dependencies", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson, null, 2)
        )

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
            "/lodash/4.17.21": {},
          },
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile, null, 2)
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved1 = resolver.resolve(ctx)
        const resolved2 = resolver.resolve(ctx)

        const hash1 = (resolved1[0] as any).hash
        const hash2 = (resolved2[0] as any).hash

        assert.strictEqual(hash1, hash2, "Hash should be deterministic")
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it("produces different hash when dependencies change", () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "builderman-pnpm-test-")
      )

      try {
        const packageJson1 = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson1, null, 2)
        )

        const lockfile1 = {
          lockfileVersion: "6.0",
          importers: {
            ".": {
              dependencies: {
                lodash: "4.17.21",
              },
            },
          },
          packages: {
            "/lodash/4.17.21": {},
          },
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile1, null, 2)
        )

        const resolver = pnpm.package({ scope: "local" })
        const ctx: ResolveContext = {
          taskCwd: testDir,
          rootCwd: testDir,
        }

        const resolved1 = resolver.resolve(ctx)
        const hash1 = (resolved1[0] as any).hash

        // Change dependencies
        const packageJson2 = {
          name: "test-package",
          version: "1.0.0",
          dependencies: {
            lodash: "^4.17.21",
            express: "^4.18.0",
          },
        }
        fs.writeFileSync(
          path.join(testDir, "package.json"),
          JSON.stringify(packageJson2, null, 2)
        )

        const lockfile2 = {
          lockfileVersion: "6.0",
          importers: {
            ".": {
              dependencies: {
                lodash: "4.17.21",
                express: "4.18.0",
              },
            },
          },
          packages: {
            "/lodash/4.17.21": {},
            "/express/4.18.0": {},
          },
        }
        fs.writeFileSync(
          path.join(testDir, "pnpm-lock.yaml"),
          JSON.stringify(lockfile2, null, 2)
        )

        const resolved2 = resolver.resolve(ctx)
        const hash2 = (resolved2[0] as any).hash

        assert.notStrictEqual(
          hash1,
          hash2,
          "Hash should change when dependencies change"
        )
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })
})
