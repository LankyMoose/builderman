const fs = require("node:fs")
const path = require("node:path")

// node setup -p beepboop -g LankyMoose -e rausten93@gmail.com

const args = process.argv.slice(2)

function getArgValue(...argsToMatch) {
  for (const arg of argsToMatch) {
    const index = args.indexOf(arg)
    if (index === -1) {
      continue
    }
    return args[index + 1]
  }
}

// prompt user for package name
const packageName = getArgValue("--package", "-p") // %PACKAGE-NAME%
if (!packageName) {
  console.error("Please provide a package name")
  process.exit(1)
}

const myGithub = getArgValue("--github", "-g") // %GITHUB-USERNAME%
if (!myGithub) {
  console.error("Please provide the github name (eg. LankyMoose)")
  process.exit(1)
}

const email = getArgValue("--email", "-e") // %EMAIL-ADDRESS%
if (!email) {
  console.error("Please provide an email address")
  process.exit(1)
}

const cwd = process.cwd()
const files = fs
  .readdirSync(cwd, { withFileTypes: true, recursive: true })
  .filter(
    (dirent) =>
      dirent.isFile() &&
      !dirent.path.includes(".git") &&
      dirent.name !== "setup.js"
  )

for (const file of files) {
  const filePath = path.join(file.path, file.name)
  const content = fs.readFileSync(filePath, "utf8")
  const updatedContent = content
    .replaceAll("%PACKAGE-NAME%", packageName)
    .replaceAll("%GITHUB-USERNAME%", myGithub)
    .replaceAll("%EMAIL-ADDRESS%", email)
  fs.writeFileSync(filePath, updatedContent)
}

console.log("Setup complete")

// delete setup.js
fs.unlinkSync("setup.js")
