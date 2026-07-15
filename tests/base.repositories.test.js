const path = require("node:path")
const process = require("node:process")
const {spawnSync} = require("node:child_process")

test("base repository queries paginate and retry empty responses", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "base.repositories.cases.mjs")], {encoding: "utf8"})
  if (result.status !== 0)
    console.error(result.stdout, result.stderr)
  expect(result.status).toBe(0)
})
