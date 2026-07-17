import assert from "node:assert/strict"
import base from "../source/plugins/base/index.mjs"

const login = "metrics-test"

function repository(index) {
  return {
    name: `repository-${index}`,
    owner: {login},
    languages: {edges: []},
  }
}

async function loadRepositories({repositories, totalCount, emptyFirstPage = false, repositoryError = null, repositoryErrorType = null, repositoryErrorAlways = false, contributedCountError = null, contributionError = null, indepth = false}) {
  const calls = []
  const contributionCalls = []
  let returnedEmptyPage = false
  let returnedRepositoryError = false
  const data = {base: {}}
  const queries = {
    base: {
      user: () => ({kind: "user"}),
      "user.x": () => ({kind: "user.x"}),
      field: options => ({kind: "field", ...options}),
      contributions: options => ({kind: "contributions", ...options}),
      repositories: options => ({kind: "repositories", ...options}),
    },
  }
  const graphql = async query => {
    if (query.kind === "user")
      return {user: {createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()}}
    if (query.kind === "user.x") {
      return {
        user: {
          contributionsCollection: {
            totalRepositoriesWithContributedCommits: 0,
            totalCommitContributions: 0,
            restrictedContributionsCount: 0,
            totalIssueContributions: 0,
            totalPullRequestContributions: 0,
            totalPullRequestReviewContributions: 0,
          },
          packages: {totalCount: 0},
          repositories: {totalCount, totalDiskUsage: 0},
        },
      }
    }
    if (query.kind === "field") {
      if (contributedCountError)
        throw contributedCountError
      return {user: {repositoriesContributedTo: {totalCount: 0}}}
    }
    if (query.kind === "contributions") {
      contributionCalls.push(query.field)
      if (contributionError) {
        contributionError.calls = contributionCalls
        throw contributionError
      }
      return {
        user: {
          contributionsCollection: {
            totalRepositoriesWithContributedCommits: 1,
            totalCommitContributions: 1,
            restrictedContributionsCount: 1,
            totalIssueContributions: 1,
            totalPullRequestContributions: 1,
            totalPullRequestReviewContributions: 1,
          },
        },
      }
    }
    if (query.kind !== "repositories")
      throw new Error(`Unexpected query: ${query.kind}`)

    calls.push({type: query.type, size: query.repositories, after: query.after})
    if ((repositoryError) && ((!repositoryErrorType) || (query.type === repositoryErrorType)) && ((repositoryErrorAlways) || (!returnedRepositoryError))) {
      returnedRepositoryError = true
      repositoryError.calls = calls
      throw repositoryError
    }
    if (query.type === "repositoriesContributedTo") {
      return {
        user: {
          repositoriesContributedTo: {
            edges: [],
            nodes: [],
            pageInfo: {endCursor: null, hasNextPage: false},
          },
        },
      }
    }
    if ((emptyFirstPage) && (!returnedEmptyPage)) {
      returnedEmptyPage = true
      return {user: {repositories: {edges: [], nodes: []}}}
    }

    const offset = Number(query.after.match(/cursor-(?<offset>\d+)/)?.groups?.offset ?? 0)
    const count = Math.min(query.repositories, totalCount - offset)
    const end = offset + count
    const cursor = count ? `cursor-${end}` : null
    return {
      user: {
        repositories: {
          edges: cursor ? [{cursor}] : [],
          nodes: Array.from({length: count}, (_, index) => repository(offset + index)),
          pageInfo: {endCursor: cursor, hasNextPage: end < totalCount},
        },
      },
    }
  }
  const imports = {
    metadata: {
      plugins: {
        base: {
          extras: () => false,
          inputs: () => ({
            indepth,
            hireable: false,
            skip: false,
            "repositories.affiliations": ["owner"],
            "repositories.batch": 25,
            "repositories.forks": false,
            "repositories.skipped": [],
            "users.ignored": [],
            "commits.authoring": [],
          }),
        },
      },
    },
  }
  const rest = {
    packages: {listPackagesForUser: async () => ({data: []})},
    search: {commits: async () => ({data: {total_count: 0}})},
  }
  const conf = {
    authenticated: login,
    settings: {
      plugins: {base: {parts: []}},
      repositories,
    },
  }

  imports.metadata.plugins.base.extras = name => (name === "indepth") && indepth

  await base({login, graphql, rest, data, q: {}, queries, imports}, conf)
  return {calls, contributionCalls, data}
}

{
  const {calls, data} = await loadRepositories({repositories: 60, totalCount: 60})
  assert.equal(data.user.repositories.nodes.length, 60)
  assert.deepEqual(calls.filter(({type}) => type === "repositories").map(({size}) => size), [25, 25, 10])
}

{
  const {calls, data} = await loadRepositories({repositories: 20, totalCount: 20, emptyFirstPage: true})
  assert.equal(data.user.repositories.nodes.length, 20)
  assert.deepEqual(calls.filter(({type}) => type === "repositories").map(({size}) => size), [20, 10, 10])
}

{
  const error = Object.assign(new Error("You have exceeded a secondary rate limit"), {
    status: 403,
    response: {headers: {"retry-after": "60"}},
  })
  await assert.rejects(loadRepositories({repositories: 20, totalCount: 20, repositoryError: error}), candidate => candidate === error)
  assert.deepEqual(error.calls.filter(({type}) => type === "repositories").map(({size}) => size), [20])
}

{
  const error = new Error("Request failed due to following response errors: Resource limits for this query exceeded.")
  const {calls, data} = await loadRepositories({repositories: 20, totalCount: 20, repositoryError: error})
  assert.equal(data.user.repositories.nodes.length, 20)
  assert.deepEqual(calls.filter(({type}) => type === "repositories").map(({size}) => size), [20, 10, 10])
}

{
  const error = new Error("Request failed due to following response errors: Resource limits for this query exceeded.")
  const {calls, data} = await loadRepositories({repositories: 20, totalCount: 20, repositoryError: error, repositoryErrorType: "repositoriesContributedTo", repositoryErrorAlways: true})
  assert.equal(data.user.repositories.nodes.length, 20)
  assert.deepEqual(data.user.repositoriesContributedTo.nodes, [])
  assert.deepEqual(calls.filter(({type}) => type === "repositoriesContributedTo").map(({size}) => size), [20, 10, 5, 2, 1])
}

{
  const error = new Error("Request failed due to following response errors: Resource limits for this query exceeded.")
  const {calls, data} = await loadRepositories({repositories: 20, totalCount: 20, contributedCountError: error})
  assert.equal(data.user.repositories.nodes.length, 20)
  assert.deepEqual(data.user.repositoriesContributedTo.nodes, [])
  assert.equal(Number.isNaN(data.user.repositoriesContributedTo.totalCount), true)
  assert.equal(calls.some(({type}) => type === "repositoriesContributedTo"), false)
}

{
  const error = Object.assign(new Error("You have exceeded a secondary rate limit"), {
    status: 403,
    response: {headers: {"retry-after": "60"}},
  })
  await assert.rejects(loadRepositories({repositories: 1, totalCount: 1, contributionError: error, indepth: true}), candidate => candidate === error)
  assert.equal(error.calls.length, 1)
}

{
  const fields = [
    "totalRepositoriesWithContributedCommits",
    "totalCommitContributions",
    "restrictedContributionsCount",
    "totalIssueContributions",
    "totalPullRequestContributions",
    "totalPullRequestReviewContributions",
  ]
  const {contributionCalls} = await loadRepositories({repositories: 1, totalCount: 1, indepth: true})
  assert.equal(contributionCalls.length, 1)
  for (const field of fields)
    assert.match(contributionCalls[0], new RegExp(`(^|\\n)${field}($|\\n)`))
}
