import assert from "node:assert/strict"
import notable from "../source/plugins/notable/index.mjs"

const resourceLimit = Object.assign(new Error("Resource limits for this query exceeded."), {
  errors: [{type: "RESOURCE_LIMITS_EXCEEDED", path: ["user", "repositoriesContributedTo"]}],
})
let calls = 0
const result = await notable({
  login: "metrics-test",
  q: {notable: true},
  imports: {
    metadata: {
      plugins: {
        notable: {
          enabled: () => true,
          inputs: () => ({filter: "", skipped: [], repositories: false, types: ["commit"], from: "all", indepth: false, self: false}),
        },
      },
    },
    filters: {repo: () => true, github: () => true},
    format: {error: error => ({error: {message: error.message, instance: error}})},
  },
  rest: {},
  graphql: async () => {
    calls++
    throw resourceLimit
  },
  data: {shared: {"repositories.skipped": [], "repositories.batch": 25}},
  account: "user",
  queries: {notable: {contributions: options => options}},
}, {enabled: true})

assert.equal(calls, 1)
assert.deepEqual(result, {contributions: [], types: ["commit"], unavailable: true})
