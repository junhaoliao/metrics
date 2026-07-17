/**
 * Base plugin is a special plugin because of historical reasons.
 * It populates initial data object directly instead of returning a result like others plugins
 */

//Imports
import {isGraphqlResourceLimit, isSecondaryRateLimit} from "../../app/retry.mjs"

const CONTRIBUTION_FIELDS = ["totalRepositoriesWithContributedCommits", "totalCommitContributions", "restrictedContributionsCount", "totalIssueContributions", "totalPullRequestContributions", "totalPullRequestReviewContributions"]
const CONTRIBUTION_WINDOW = 24 * 7 * 24 * 60 * 60 * 1000

//Setup
export default async function({login, graphql, rest, data, q, queries, imports, callbacks}, conf) {
  //Load inputs
  console.debug(`metrics/compute/${login}/base > started`)
  let {indepth, hireable, skip, "repositories.forks": _forks, "repositories.affiliations": _affiliations, "repositories.batch": _batch} = imports.metadata.plugins.base.inputs({data, q, account: "bypass"})
  const repositories = conf.settings.repositories || 100
  const forks = _forks ? "" : ", isFork: false"
  const affiliations = _affiliations?.length ? `, ownerAffiliations: [${_affiliations.map(x => x.toLocaleUpperCase()).join(", ")}]${conf.authenticated === login ? `, affiliations: [${_affiliations.map(x => x.toLocaleUpperCase()).join(", ")}]` : ""}` : ""
  console.debug(`metrics/compute/${login}/base > affiliations constraints ${affiliations}`)

  //Skip initial data gathering if not needed
  if ((conf.settings.notoken) || (skip)) {
    await callbacks?.plugin?.(login, "base", true, data).catch(error => console.debug(`metrics/compute/${login}/plugins/callbacks > base > ${error}`))
    return (postprocess.skip({login, data, imports}), {})
  }

  //Base parts (legacy handling for web instance)
  const defaulted = ("base" in q) ? legacy.converter(q.base) ?? true : true
  for (const part of conf.settings.plugins.base.parts)
    data.base[part] = `base.${part}` in q ? legacy.converter(q[`base.${part}`]) : defaulted

  //Iterate through account types
  for (const account of ["user", "organization"]) {
    let repositoriesContributedUnavailable = false
    try {
      //Query data from GitHub API
      console.debug(`metrics/compute/${login}/base > account ${account}`)
      const queried = await graphql(queries.base[account]({login}))
      Object.assign(data, {user: queried[account]})
      postprocess?.[account]({login, data})
      try {
        Object.assign(data.user, (await graphql(queries.base[`${account}.x`]({login, account, "calendar.from": new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), "calendar.to": (new Date()).toISOString(), affiliations, forks})))[account])
        console.debug(`metrics/compute/${login}/base > successfully loaded bulk query`)
      }
      catch (error) {
        if (isSecondaryRateLimit(error))
          throw error
        console.debug(`metrics/compute/${login}/base > failed to load bulk query, falling back to unit queries`)
        //Query basic fields
        const fields = {
          user: ["packages", "starredRepositories", "watching", "sponsorshipsAsSponsor", "sponsorshipsAsMaintainer", "followers", "following", "issueComments", "organizations"],
          organization: ["packages", "sponsorshipsAsSponsor", "sponsorshipsAsMaintainer", "membersWithRole"],
        }[account] ?? []
        for (const field of fields) {
          try {
            Object.assign(data.user, (await graphql(queries.base.field({login, account, field})))[account])
          }
          catch (error) {
            if (isSecondaryRateLimit(error))
              throw error
            console.debug(`metrics/compute/${login}/base > failed to retrieve ${field}`)
            data.user[field] = {totalCount: NaN}
          }
        }
        //Query repositories fields
        for (const field of ["totalCount", "totalDiskUsage"]) {
          try {
            Object.assign(data.user.repositories, (await graphql(queries.base["field.repositories"]({login, account, field, affiliations, forks})))[account].repositories)
          }
          catch (error) {
            if (isSecondaryRateLimit(error))
              throw error
            console.debug(`metrics/compute/${login}/base > failed to retrieve repositories.${field}`)
            data.user.repositories[field] = NaN
          }
        }
        //Query user account fields
        if (account === "user") {
          //Query calendar
          try {
            Object.assign(data.user, (await graphql(queries.base.calendar({login, "calendar.from": new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), "calendar.to": (new Date()).toISOString()})))[account])
          }
          catch (error) {
            if (isSecondaryRateLimit(error))
              throw error
            console.debug(`metrics/compute/${login}/base > failed to retrieve contributions calendar`)
            data.user.calendar = {contributionCalendar: {weeks: []}}
          }
        }
      }
      //Query repositories contributed to separately because GitHub can reject this field on large accounts
      if (account === "user") {
        try {
          Object.assign(data.user, (await graphql(queries.base.field({login, account, field: "repositoriesContributedTo(includeUserRepositories: true)"})))[account])
        }
        catch (error) {
          if (isSecondaryRateLimit(error))
            throw error
          repositoriesContributedUnavailable = isGraphqlResourceLimit(error)
          console.debug(`metrics/compute/${login}/base > failed to retrieve repositoriesContributedTo.totalCount`)
          data.user.repositoriesContributedTo.totalCount = NaN
        }
      }
      //Query contributions in bounded date windows because GitHub can reject an unbounded collection on large accounts
      if (account === "user") {
        const indepthEnabled = (indepth) && (imports.metadata.plugins.base.extras("indepth", {...conf.settings, error: false}))
        const end = new Date()
        const oneYearAgo = new Date(end)
        oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1)
        const created = new Date(data.user.createdAt)
        const start = indepthEnabled || (created > oneYearAgo) ? created : oneYearAgo
        try {
          Object.assign(data.user.contributionsCollection, await loadContributions({login, account, graphql, query: queries.base.contributions, start, end}))
        }
        catch (error) {
          if (isSecondaryRateLimit(error))
            throw error
          console.debug(`metrics/compute/${login}/plugins > base > failed to load bounded contributions collections`)
        }
        //Fallback to load whole commit history rather than last year
        if (!indepthEnabled) {
          try {
            console.debug(`metrics/compute/${login}/base > loading user commits history`)
            const {data: {total_count: total = 0}} = await rest.search.commits({q: `author:${login}`})
            const current = data.user.contributionsCollection.totalCommitContributions
            data.user.contributionsCollection.totalCommitContributions = Math.max(total, Number.isFinite(current) ? current : 0)
          }
          catch {
            console.debug(`metrics/compute/${login}/base > falling back to last year commits history`)
          }
        }
        //Hireable status
        if (hireable) {
          console.debug(`metrics/compute/${login}/base > is hireable`)
          data.user.isHireable = hireable
        }
      }
      //Query repositories from GitHub API
      for (const type of ({user: ["repositories", "repositoriesContributedTo"], organization: ["repositories"]}[account] ?? [])) {
        if ((type === "repositoriesContributedTo") && (repositoriesContributedUnavailable)) {
          console.debug(`metrics/compute/${login}/base > repositoriesContributedTo is unavailable due to GitHub query resource limits, skipping`)
          continue
        }
        //Iterate through repositories
        let cursor = null
        const options = {repositories: {forks, affiliations, constraints: ""}, repositoriesContributedTo: {forks: "", affiliations: "", constraints: ", includeUserRepositories: false, contributionTypes: COMMIT"}}[type] ?? null
        data.user[type] = data.user[type] ?? {}
        data.user[type].nodes = data.user[type].nodes ?? []
        const total = Number(data.user[type].totalCount)
        const knownTotal = type === "repositories" && Number.isFinite(total)
        const target = knownTotal ? Math.min(repositories, total) : repositories
        while (data.user[type].nodes.length < target) {
          const requested = Math.min(target - data.user[type].nodes.length, {user: _batch, organization: Math.min(25, _batch)}[account])
          console.debug(`metrics/compute/${login}/base > retrieving ${type} after ${cursor}`)
          let connection
          try {
            const request = await graphql(queries.base.repositories({login, account, type, after: cursor ? `after: "${cursor}"` : "", repositories: requested, ...options}))
            connection = request?.[account]?.[type]
            if (!connection)
              throw repositoryResponseError(`Missing ${account}.${type} in GraphQL response`)
            if ((!connection.nodes?.length) && (knownTotal) && (data.user[type].nodes.length < target))
              throw repositoryResponseError(`Unexpected empty ${account}.${type} in GraphQL response`)
          }
          catch (error) {
            if (!shouldShrinkRepositoryBatch(error))
              throw error
            console.debug(`metrics/compute/${login}/base > received an empty, timed out, or resource-limited response while retrieving ${requested} repositories after ${cursor}, halving batch`)
            const reduced = Math.floor(requested / 2)
            if (reduced < 1) {
              if ((type === "repositoriesContributedTo") && (isGraphqlResourceLimit(error))) {
                console.debug(`metrics/compute/${login}/base > repositoriesContributedTo remains unavailable with a batch of 1, skipping`)
                break
              }
              console.debug(`metrics/compute/${login}/base > failed to retrieve repositories, cannot halve batch anymore`)
              throw error
            }
            _batch = reduced
            continue
          }
          const {edges = [], nodes = [], pageInfo = {}} = connection
          cursor = pageInfo.endCursor ?? edges?.[edges?.length - 1]?.cursor
          data.user[type].nodes.push(...nodes)
          console.debug(`metrics/compute/${login}/base > retrieved ${nodes.length} ${type} after ${cursor}`)
          if ((pageInfo.hasNextPage === false) || (!cursor) || ((pageInfo.hasNextPage !== true) && (nodes.length < requested))) {
            console.debug(`metrics/compute/${login}/base > retrieved less repositories than expected, probably no more to fetch`)
            break
          }
        }
        //Limit repositories
        console.debug(`metrics/compute/${login}/base > keeping only ${repositories} ${type}`)
        data.user[type].nodes.splice(repositories)
        console.debug(`metrics/compute/${login}/base > loaded ${data.user[type].nodes.length} ${type}`)
      }
      //Fetch missing packages count from ghcr.io using REST API (as GraphQL API does not support it yet)
      try {
        console.debug(`metrics/compute/${login}/base > patching packages count if possible`)
        const {data: packages} = await rest.packages[{user: "listPackagesForUser", organization: "listPackagesForOrganization"}[account]]({package_type: "container", org: login, username: login})
        data.user.packages.totalCount += packages.length
        console.debug(`metrics/compute/${login}/base > patched packages count (added ${packages.length} from ghcr.io)`)
      }
      catch {
        console.debug(`metrics/compute/${login}/base > failed to patch packages count, maybe read:packages scope was not provided`)
      }
      //Shared options
      let {"repositories.skipped": skipped, "users.ignored": ignored, "commits.authoring": authoring} = imports.metadata.plugins.base.inputs({data, q, account: "bypass"})
      data.shared = {"repositories.skipped": skipped, "users.ignored": ignored, "commits.authoring": authoring, "repositories.batch": _batch}
      console.debug(`metrics/compute/${login}/base > shared options > ${JSON.stringify(data.shared)}`)
      //Success
      console.debug(`metrics/compute/${login}/base > graphql query > account ${account} > success`)
      await callbacks?.plugin?.(login, "base", true, data).catch(error => console.debug(`metrics/compute/${login}/plugins/callbacks > base > ${error}`))
      return {}
    }
    catch (error) {
      console.debug(`metrics/compute/${login}/base > account ${account} > failed : ${error}`)
      if (/Could not resolve to a User with the login of/.test(error.message)) {
        console.debug(`metrics/compute/${login}/base > got a "user not found" error for account type "${account}" and user "${login}"`)
        console.debug(`metrics/compute/${login}/base > checking next account type`)
        continue
      }
      throw error
    }
  }
  //Not found
  console.debug(`metrics/compute/${login}/base > no more account type`)
  await callbacks?.plugin?.(login, "base", false, data).catch(error => console.debug(`metrics/compute/${login}/plugins/callbacks > base > ${error}`))
  throw new Error("user not found")
}

function repositoryResponseError(message) {
  return Object.assign(new Error(message), {code: "METRICS_REPOSITORY_RESPONSE"})
}

function shouldShrinkRepositoryBatch(error) {
  const status = Number(error?.status ?? error?.response?.status)
  if ([403, 429].includes(status))
    return false
  return (error?.code === "METRICS_REPOSITORY_RESPONSE") || ([502, 504].includes(status)) || /timed? ?out|timeout|something went wrong while executing your query/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`) || isGraphqlResourceLimit(error)
}

async function loadContributions({login, account, graphql, query, start, end}) {
  const collection = Object.fromEntries(CONTRIBUTION_FIELDS.map(field => [field, 0]))
  for (let from = new Date(start); from < end;) {
    const next = new Date(Math.min(from.getTime() + CONTRIBUTION_WINDOW, end.getTime()))
    const to = new Date(next.getTime() - 1)
    const contribution = await loadContributionRange({login, account, graphql, query, from, to})
    for (const field of CONTRIBUTION_FIELDS)
      collection[field] += contribution[field]
    from = next
  }
  return collection
}

async function loadContributionRange({login, account, graphql, query, from, to}) {
  try {
    console.debug(`metrics/compute/${login}/plugins > base > loading contributions collections from "${from.toISOString()}" to "${to.toISOString()}"`)
    const response = await graphql(query({login, account, field: CONTRIBUTION_FIELDS.join("\n"), range: `(from: "${from.toISOString()}", to: "${to.toISOString()}")`}))
    const contribution = response?.[account]?.contributionsCollection
    if ((!contribution) || (CONTRIBUTION_FIELDS.some(field => !Number.isFinite(contribution[field]))))
      throw new Error("Incomplete contributions collection response")
    return contribution
  }
  catch (error) {
    if (isSecondaryRateLimit(error))
      throw error
    const duration = to.getTime() - from.getTime()
    if ((!isGraphqlResourceLimit(error)) || (duration < 2 * 24 * 60 * 60 * 1000))
      throw error
    const midpoint = new Date(from.getTime() + Math.ceil(duration / 2))
    console.debug(`metrics/compute/${login}/plugins > base > contribution range exceeded GitHub resource limits, splitting at "${midpoint.toISOString()}"`)
    const left = await loadContributionRange({login, account, graphql, query, from, to: new Date(midpoint.getTime() - 1)})
    const right = await loadContributionRange({login, account, graphql, query, from: midpoint, to})
    return Object.fromEntries(CONTRIBUTION_FIELDS.map(field => [field, left[field] + right[field]]))
  }
}

//Query post-processing
const postprocess = {
  //User
  user({login, data}) {
    console.debug(`metrics/compute/${login}/base > applying postprocessing`)
    data.account = "user"
    Object.assign(data.user, {
      isHireable: false,
      isVerified: false,
      repositories: {},
      repositoriesContributedTo: {totalCount: NaN, nodes: []},
      contributionsCollection: Object.fromEntries(CONTRIBUTION_FIELDS.map(field => [field, NaN])),
    })
  },
  //Organization
  organization({login, data}) {
    console.debug(`metrics/compute/${login}/base > applying postprocessing`)
    data.account = "organization"
    Object.assign(data.user, {
      isHireable: false,
      repositories: {},
      starredRepositories: {totalCount: NaN},
      watching: {totalCount: NaN},
      contributionsCollection: {
        totalRepositoriesWithContributedCommits: NaN,
        totalCommitContributions: NaN,
        restrictedContributionsCount: NaN,
        totalIssueContributions: NaN,
        totalPullRequestContributions: NaN,
        totalPullRequestReviewContributions: NaN,
      },
      calendar: {contributionCalendar: {weeks: []}},
      repositoriesContributedTo: {totalCount: NaN, nodes: []},
      followers: {totalCount: NaN},
      following: {totalCount: NaN},
      issueComments: {totalCount: NaN},
      organizations: {totalCount: NaN},
    })
  },
  //Skip base content query and instantiate an empty user instance
  skip({login, data, imports}) {
    data.user = {}
    data.shared = imports.metadata.plugins.base.inputs({data, q: {}, account: "bypass"})
    for (const account of ["user", "organization"])
      postprocess?.[account]({login, data})
    data.account = "bypass"
    Object.assign(data.user, {
      databaseId: NaN,
      name: login,
      login,
      createdAt: new Date(),
      avatarUrl: `https://github.com/${login}.png`,
      websiteUrl: null,
      twitterUsername: login,
      repositories: {totalCount: NaN, totalDiskUsage: NaN, nodes: []},
      packages: {totalCount: NaN},
      repositoriesContributedTo: {totalCount: NaN, nodes: []},
    })
  },
}

//Legacy functions
const legacy = {
  converter(value) {
    if (/^(?:[Tt]rue|[Oo]n|[Yy]es|1)$/.test(value))
      return true
    if (/^(?:[Ff]alse|[Oo]ff|[Nn]o|0)$/.test(value))
      return false
    if (Number.isFinite(Number(value)))
      return !!(Number(value))
  },
}
