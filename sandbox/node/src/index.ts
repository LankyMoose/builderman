import { task, pipeline } from "builderman"

const a = task({
  name: "a",
  commands: {
    build: "echo 'a'",
  },
})

const b = task({
  name: "b",
  dependencies: [a],
  env: {
    LOG_LEVEL: "info",
    TEST: "test",
  },
  commands: {
    build: {
      run: "node src/b.ts",
      env: {
        LOG_LEVEL: "debug",
      },
    },
  },
})

const result = await pipeline([a, b]).run({
  command: "build",
})

if (result.ok) {
  console.log("Pipeline completed successfully")
} else {
  console.log("Pipeline failed")
}
