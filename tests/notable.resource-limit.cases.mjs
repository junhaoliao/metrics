import assert from "node:assert/strict"
import notable from "../source/plugins/notable/index.mjs"

const resourceLimit = Object.assign(new Error("Resource limits for this query exceeded."), {
  errors: [{type: "RESOURCE_LIMITS_EXCEEDED", path: ["user", "repositoriesContributedTo"]}],
})
let calls = 0
let fallbackQuery = null
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
    imgb64: async url => url,
  },
  rest: {},
  graphql: async query => {
    calls++
    if (query.kind === "contributions")
      throw resourceLimit
    fallbackQuery = query
    return {
      user: {
        contributionsCollection: {
          commitContributionsByRepository: [{
            repository: {
              isInOrganization: true,
              owner: {login: "example", avatarUrl: "https://example.com/avatar.png"},
              nameWithOwner: "example/project",
              stargazers: {totalCount: 100},
              watchers: {totalCount: 10},
              forks: {totalCount: 5},
              issues: {totalCount: 20},
              pullRequests: {totalCount: 15},
            },
            contributions: {totalCount: 3},
          }],
        },
      },
    }
  },
  data: {
    shared: {"repositories.skipped": [], "repositories.batch": 25},
    user: {createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()},
  },
  account: "user",
  queries: {
    notable: {
      contributions: options => ({kind: "contributions", ...options}),
      "contributions.fallback": options => ({kind: "contributions.fallback", ...options}),
    },
  },
}, {enabled: true})

assert.equal(calls, 2)
assert.match(fallbackQuery.range, /^\(from: /)
assert.match(fallbackQuery.contributions, /commitContributionsByRepository/)
assert.equal(result.unavailable, undefined)
assert.equal(result.contributions.length, 1)
assert.equal(result.contributions[0].handle, "example/project")
