//Imports
const path = require("path")
const git = require("simple-git")(path.join(__dirname, ".."))

//Edited files list
const diff = async () => (await git.diff(["origin/main...", "--name-status"])).split("\n").map(x => x.trim()).filter(x => /^M\s+/.test(x)).map(x => x.replace(/^M\s+/, ""))

//File changes
describe("Check file changes (checkout your files if needed)", () => {
  describe("Auto-generated files were not modified", () =>
    void test.each([
      "action.yml",
      "settings.example.json",
    ])("%s", async file => expect((await diff()).includes(file)).toBe(false)))
})
