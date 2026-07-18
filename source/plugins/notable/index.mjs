//Imports
import {isGraphqlResourceLimit} from "../../app/retry.mjs"

const CONTRIBUTION_FIELDS = {
  commit: "commitContributionsByRepository",
  issue: "issueContributionsByRepository",
  pull_request: "pullRequestContributionsByRepository",
}
const CONTRIBUTION_WINDOW = 24 * 7 * 24 * 60 * 60 * 1000
const MAX_REPOSITORIES = 100

//Setup
export default async function({login, q, imports, rest, graphql, data, account, queries}, {enabled = false, extras = false} = {}) {
  //Plugin execution
  try {
    //Check if plugin is enabled and requirements are met
    if ((!q.notable) || (!imports.metadata.plugins.notable.enabled(enabled, {extras})))
      return null

    //Load inputs
    let {filter, skipped, repositories, types, from, indepth, self} = imports.metadata.plugins.notable.inputs({data, account, q})
    skipped.push(...data.shared["repositories.skipped"])

    //Iterate through contributed repositories
    let contributions = []
    {
      let cursor = null
      let pushed = 0
      do {
        console.debug(`metrics/compute/${login}/plugins > notable > retrieving contributed repositories after ${cursor}`)
        let response
        try {
          response = await graphql(queries.notable.contributions({login, types: types.map(x => x.toLocaleUpperCase()).join(", "), after: cursor ? `after: "${cursor}"` : "", self, repositories: data.shared["repositories.batch"] || 100}))
        }
        catch (error) {
          if (isGraphqlResourceLimit(error)) {
            console.debug(`metrics/compute/${login}/plugins > notable > repositoriesContributedTo is unavailable due to GitHub query resource limits, loading bounded contribution collections`)
            const nodes = await loadContributedRepositories({login, graphql, query: queries.notable["contributions.fallback"], types, createdAt: data.user.createdAt})
            response = {user: {repositoriesContributedTo: {edges: nodes.map(node => ({node}))}}}
          }
          else {
            throw error
          }
        }
        const {user: {repositoriesContributedTo: {edges}}} = response
        cursor = edges?.[edges?.length - 1]?.cursor
        edges
          .filter(({node}) => self || (node.owner.login.toLocaleLowerCase() !== login.toLocaleLowerCase()))
          .filter(({node}) => imports.filters.repo(node, skipped))
          .filter(({node}) => ({all: true, organization: node.isInOrganization, user: !node.isInOrganization}[from]))
          .filter(({node}) => imports.filters.github(filter, {name: node.nameWithOwner, user: node.owner.login, stars: node.stargazers.totalCount, watchers: node.watchers.totalCount, forks: node.forks.totalCount}))
          .map(({node}) => contributions.push({handle: node.nameWithOwner, stars: node.stargazers.totalCount, issues: node.issues.totalCount, pulls: node.pullRequests.totalCount, organization: node.isInOrganization, avatarUrl: node.owner.avatarUrl}))
        pushed = edges.length
      }
      while ((pushed) && (cursor))
    }

    //Set contributions
    contributions = await Promise.all(contributions.map(async ({handle, stars, issues, pulls, avatarUrl, organization}) => ({name: handle.split("/").shift(), handle, stars, issues, pulls, avatar: await imports.imgb64(avatarUrl), organization})))
    console.debug(`metrics/compute/${login}/plugins > notable > found ${contributions.length} notable contributions`)

    //Indepth
    if ((indepth) && (imports.metadata.plugins.notable.extras("indepth", {extras}))) {
      console.debug(`metrics/compute/${login}/plugins > notable > indepth`)

      //Fetch issues
      const issues = {}
      if (types.includes("issue")) {
        let cursor = null
        let pushed = 0
        do {
          console.debug(`metrics/compute/${login}/plugins > notable > retrieving user issues after ${cursor}`)
          const {user: {issues: {edges}}} = await graphql(queries.notable.issues({login, type: "issues", after: cursor ? `after: "${cursor}"` : ""}))
          cursor = edges?.[edges?.length - 1]?.cursor
          edges.map(({node: {repository: {nameWithOwner: repository}}}) => issues[repository] = (issues[repositories] ?? 0) + 1)
          pushed = edges.length
        }
        while ((pushed) && (cursor))
      }

      //Fetch pull requests
      const pulls = {}
      if (types.includes("pull_request")) {
        let cursor = null
        let pushed = 0
        do {
          console.debug(`metrics/compute/${login}/plugins > notable > retrieving user pull requests after ${cursor}`)
          const {user: {pullRequests: {edges}}} = await graphql(queries.notable.issues({login, type: "pullRequests", after: cursor ? `after: "${cursor}"` : ""}))
          cursor = edges?.[edges?.length - 1]?.cursor
          edges.map(({node: {repository: {nameWithOwner: repository}}}) => pulls[repository] = (pulls[repositories] ?? 0) + 1)
          pushed = edges.length
        }
        while ((pushed) && (cursor))
      }

      //Fetch commits
      for (const contribution of contributions) {
        //Prepare data
        const {handle, stars} = contribution
        const [owner, repo] = handle.split("/")
        try {
          //Count total commits on repository
          const {repository: {defaultBranchRef: {target: {history}}}} = await graphql(queries.notable.commits({owner, repo}))
          contribution.history = history.totalCount

          //Load maintainers (errors probably means that token is not allowed to list contributors hence not a maintainer of said repo)
          const {data: collaborators} = await rest.repos.listCollaborators({owner, repo}).catch(() => ({data: []}))
          const maintainers = collaborators.filter(({role_name: role}) => ["admin", "maintain", "write"].includes(role)).map(({login}) => login)

          //Count total commits of user
          const {data: contributions = []} = await rest.repos.getContributorsStats({owner, repo})
          const commits = contributions?.filter(({author}) => author.login.toLocaleLowerCase() === login.toLocaleLowerCase()).reduce((a, {total: b}) => a + b, 0) ?? NaN

          //Save user data
          contribution.user = {
            commits,
            percentage: commits / contribution.history,
            maintainer: maintainers.includes(login),
            issues: issues[handle] ?? 0,
            pulls: pulls[handle] ?? 0,
            get stars() {
              return Math.round(this.maintainer ? stars : this.percentage * stars)
            },
          }
          console.debug(`metrics/compute/${login}/plugins > notable > indepth > successfully processed ${owner}/${repo}`)
        }
        catch (error) {
          console.debug(error)
          console.debug(`metrics/compute/${login}/plugins > notable > indepth > failed to compute for ${owner}/${repo}`)
        }
      }
    }

    //Aggregate contributions
    console.debug(`metrics/compute/${login}/plugins > notable > aggregating results`)
    const aggregated = new Map()
    for (const {name, handle, avatar, organization = handle.split("/").shift() ?? "", stars, ..._extras} of contributions) {
      const key = repositories ? handle : name
      if (aggregated.has(key)) {
        const aggregate = aggregated.get(key)
        aggregate.aggregated++
        if (indepth) {
          const {history = 0, user: {commits = 0, percentage = 0, maintainer = false} = {}} = _extras
          aggregate.history = aggregate.history ?? 0
          aggregate.history += history
          aggregate.user = aggregate.user ?? {}
          aggregate.user.commits += commits
          aggregate.user.percentage += percentage
          aggregate.user.maintainer = aggregate.user.maintainer || maintainer
        }
      }
      else {
        aggregated.set(key, {name: key, handle, avatar, organization, stars, aggregated: 1, ..._extras})
      }
    }
    contributions = [...aggregated.values()]
    if (indepth) {
      //Normalize contribution percentage
      contributions.map(aggregate => aggregate.user ? aggregate.user.percentage /= aggregate.aggregated : null)
      //Additional filtering (no user commits means that API wasn't able to answer back, considering it as matching by default)
      contributions = contributions.filter(({handle, user}) => !user?.commits ? true : imports.filters.github(filter, {handle, commits: contributions.history, "commits.user": user.commits, "commits.user%": user.percentage * 100, maintainer: user.maintainer}))
      //Sort contribution by maintainer first and then by contribution percentage
      contributions = contributions.sort((a, b) => ((b.user?.percentage + b.user?.maintainer) || 0) - ((a.user?.percentage + a.user?.maintainer) || 0))
    }

    //Results
    return {contributions, types}
  }
  //Handle errors
  catch (error) {
    throw imports.format.error(error)
  }
}

async function loadContributedRepositories({login, graphql, query, types, createdAt}) {
  const repositories = new Map()
  const end = new Date()
  for (let from = new Date(createdAt); from < end;) {
    const next = new Date(Math.min(from.getTime() + CONTRIBUTION_WINDOW, end.getTime()))
    const to = new Date(next.getTime() - 1)
    const nodes = await loadContributionRange({login, graphql, query, types, from, to})
    for (const node of nodes)
      repositories.set(node.nameWithOwner.toLocaleLowerCase(), node)
    from = next
  }
  return [...repositories.values()].sort((a, b) => b.stargazers.totalCount - a.stargazers.totalCount)
}

async function loadContributionRange({login, graphql, query, types, from, to}) {
  try {
    console.debug(`metrics/compute/${login}/plugins > notable > loading bounded contributions from "${from.toISOString()}" to "${to.toISOString()}"`)
    const response = await graphql(query({
      login,
      range: `(from: "${from.toISOString()}", to: "${to.toISOString()}")`,
      contributions: contributionFields(types),
    }))
    const collection = response?.user?.contributionsCollection
    if (!collection)
      throw new Error("Incomplete notable contributions response")
    const saturated = types.some(type => collection[CONTRIBUTION_FIELDS[type]]?.length >= MAX_REPOSITORIES)
    if (saturated)
      throw Object.assign(new Error("Notable contributions response reached the repository limit"), {code: "METRICS_NOTABLE_RESPONSE_LIMIT"})
    return types.flatMap(type => collection[CONTRIBUTION_FIELDS[type]] ?? []).map(({repository}) => repository).filter(Boolean)
  }
  catch (error) {
    const duration = to.getTime() - from.getTime()
    if (((!isGraphqlResourceLimit(error)) && (error?.code !== "METRICS_NOTABLE_RESPONSE_LIMIT")) || (duration < 2 * 24 * 60 * 60 * 1000))
      throw error
    const midpoint = new Date(from.getTime() + Math.ceil(duration / 2))
    console.debug(`metrics/compute/${login}/plugins > notable > contribution range was rejected or full, splitting at "${midpoint.toISOString()}"`)
    return [
      ...await loadContributionRange({login, graphql, query, types, from, to: new Date(midpoint.getTime() - 1)}),
      ...await loadContributionRange({login, graphql, query, types, from: midpoint, to}),
    ]
  }
}

function contributionFields(types) {
  return types.map(type => `${CONTRIBUTION_FIELDS[type]}(maxRepositories: ${MAX_REPOSITORIES}) {
      repository {
        isInOrganization
        owner {
          login
          avatarUrl
        }
        nameWithOwner
        watchers {
          totalCount
        }
        forks {
          totalCount
        }
        stargazers {
          totalCount
        }
        issues {
          totalCount
        }
        pullRequests {
          totalCount
        }
      }
    }`).join("\n")
}
