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

async function loadRepositories({repositories, totalCount, emptyFirstPage = false}) {
  const calls = []
  let returnedEmptyPage = false
  const data = {base: {}}
  const queries = {
    base: {
      user: () => ({kind: "user"}),
      "user.x": () => ({kind: "user.x"}),
      repositories: options => ({kind: "repositories", ...options}),
    },
  }
  const graphql = async query => {
    if (query.kind === "user")
      return {user: {createdAt: "2020-01-01T00:00:00.000Z"}}
    if (query.kind === "user.x") {
      return {
        user: {
          contributionsCollection: {totalCommitContributions: 0},
          packages: {totalCount: 0},
          repositories: {totalCount, totalDiskUsage: 0},
          repositoriesContributedTo: {totalCount: 0},
        },
      }
    }
    if (query.kind !== "repositories")
      throw new Error(`Unexpected query: ${query.kind}`)

    calls.push({type: query.type, size: query.repositories, after: query.after})
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
            indepth: false,
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

  await base({login, graphql, rest, data, q: {}, queries, imports}, conf)
  return {calls, data}
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
