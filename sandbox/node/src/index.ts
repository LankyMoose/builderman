import { task, pipeline } from "builderman"

const a = task({
  name: "a",
  commands: {
    build: {
      run: "echo 'a'",
      cache: {
        inputs: ["src"],
        outputs: ["dist"],
      },
    },
  },
})

const b = task({
  name: "b",
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
      dependencies: [a],
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
