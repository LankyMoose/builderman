// Script that prints a READY marker after a short delay and keeps running briefly
console.log("starting ready script")

setTimeout(() => {
  console.log("READY")
}, 25)

setTimeout(() => {
  console.log("completed ready script")
  process.exit(0)
}, 120)
