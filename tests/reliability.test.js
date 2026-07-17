const path = require("node:path")
const process = require("node:process")
const {spawnSync} = require("node:child_process")

test("request reliability helpers retry and bound concurrency", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "reliability.cases.mjs")], {encoding: "utf8"})
  if (result.status !== 0)
    console.error(result.stdout, result.stderr)
  expect(result.status).toBe(0)
})

test("notable contributions tolerate GitHub repository resource limits", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "notable.resource-limit.cases.mjs")], {encoding: "utf8"})
  if (result.status !== 0)
    console.error(result.stdout, result.stderr)
  expect(result.status).toBe(0)
})
