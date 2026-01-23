```ts
import { task, pipeline } from "builderman"

const build = task({
  name: "build",
  commands: {
    build: "tsc",
    dev: "tsc --watch",
  },
})

const test = task({
  name: "test",
  commands: {
    build: "npm test",
  },
  dependencies: [build],
})

const deploy = task({
  name: "deploy",
  commands: {
    build: "npm run deploy",
  },
  dependencies: [test],
})

const result = await pipeline([build, test, deploy]).run({
  command: "build",
})

console.log(result)
```
