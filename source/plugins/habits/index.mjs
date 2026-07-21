//Legacy import
import { recent as recent_analyzer } from "./../languages/analyzers.mjs"

//Setup
export default async function({login, data, rest, imports, q, account}, {enabled = false, extras = false, ...defaults} = {}) {
  //Plugin execution
  try {
    //Check if plugin is enabled and requirements are met
    if ((!q.habits) || (!imports.metadata.plugins.habits.enabled(enabled, {extras})))
      return null

    //Load inputs
    let {from, days, facts, charts, "charts.type": _charts, trim, "languages.limit": limit, "languages.threshold": threshold, skipped = []} = imports.metadata.plugins.habits.inputs({data, account, q}, defaults)
    threshold = (Number(threshold.replace(/%$/, "")) || 0) / 100
    skipped.push(...data.shared["repositories.skipped"])

    //Initialization
    const habits = {facts, charts, trim, lines: {average: {chars: 0}}, commits: {fetched: 0, hour: NaN, hours: {}, day: NaN, days: {}}, indents: {style: "", spaces: 0, tabs: 0}, linguist: {available: false, ordered: [], languages: {}}}
    //GitHub caps user event timelines at 300 entries
    const pages = Math.min(Math.ceil(from / 100), 3)
    const offset = data.config.timezone?.offset ?? 0

    //Get user recent activity
    console.debug(`metrics/compute/${login}/plugins > habits > querying api`)
    const events = []
    try {
      for (let page = 1; page <= pages; page++) {
        console.debug(`metrics/compute/${login}/plugins > habits > loading page ${page}`)
        events.push(...(await rest.activity.listEventsForAuthenticatedUser({username: login, per_page: 100, page})).data)
      }
    }
    catch {
      console.debug(`metrics/compute/${login}/plugins > habits > no more page to load`)
    }
    console.debug(`metrics/compute/${login}/plugins > habits > ${events.length} events loaded`)

    //Get user recent commits
    const pushes = events
      .filter(({type}) => type === "PushEvent")
      .filter(({actor}) => account === "organization" ? true : actor.login?.toLocaleLowerCase() === login.toLocaleLowerCase())
      .filter(({repo: {name: repo}}) => imports.filters.repo(repo, skipped))
      .filter(({created_at}) => new Date(created_at) > new Date(Date.now() - days * 24 * 60 * 60 * 1000))
    console.debug(`metrics/compute/${login}/plugins > habits > filtered out ${pushes.length} push events over last ${days} days`)

    //Get commit timestamps independently from the capped events timeline
    let commits = null
    if (account === "user") {
      try {
        console.debug(`metrics/compute/${login}/plugins > habits > searching commits over last ${days} days`)
        commits = await searchRecentCommits({login, rest, days, skipped, imports})
        console.debug(`metrics/compute/${login}/plugins > habits > ${commits.length} commits loaded from search`)
      }
      catch (error) {
        console.debug(`metrics/compute/${login}/plugins > habits > commit search unavailable, falling back to push events (${error})`)
      }
    }
    commits ??= pushes.map(({created_at, repo: {name: repo}}) => ({created_at, repo}))
    habits.commits.fetched = commits.length

    //Retrieve edited files and filter edited lines (those starting with +/-) from patches
    console.debug(`metrics/compute/${login}/plugins > habits > loading patches`)
    const patches = [
      ...await Promise.allSettled(
        pushes
          .flatMap(({payload}) => payload.commits)
          .filter(commit => commit)
          .filter(({author}) => data.shared["commits.authoring"].filter(authoring => author?.login?.toLocaleLowerCase().includes(authoring) || author?.email?.toLocaleLowerCase().includes(authoring) || author?.name?.toLocaleLowerCase().includes(authoring)).length)
          .map(async commit => (await rest.request(commit)).data.files),
      ),
    ]
      .filter(({status}) => status === "fulfilled")
      .map(({value}) => value)
      .flatMap(files => files.map(file => ({name: imports.paths.basename(file.filename), patch: file.patch ?? ""})))
      .map(({name, patch}) => ({name, patch: patch.split("\n").filter(line => /^[+]/.test(line)).map(line => line.substring(1)).join("\n")}))

    //Commit day
    {
      //Compute commit days
      console.debug(`metrics/compute/${login}/plugins > habits > searching most active day of week`)
      const days = commits.map(({created_at}) => (new Date(new Date(created_at).getTime() + offset)).getDay())
      for (const day of days)
        habits.commits.days[day] = (habits.commits.days[day] ?? 0) + 1
      habits.commits.days.max = Math.max(...Object.values(habits.commits.days))
      //Compute day with most commits
      habits.commits.day = days.length ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Object.entries(habits.commits.days).sort(([_an, a], [_bn, b]) => b - a).map(([day, _occurrence]) => day)[0]] ?? NaN : NaN
    }

    //Commit hour
    {
      //Compute commit hours
      console.debug(`metrics/compute/${login}/plugins > habits > searching most active time of day`)
      const hours = commits.map(({created_at}) => (new Date(new Date(created_at).getTime() + offset)).getHours())
      for (const hour of hours)
        habits.commits.hours[hour] = (habits.commits.hours[hour] ?? 0) + 1
      habits.commits.hours.max = Math.max(...Object.values(habits.commits.hours))
      //Compute hour with most commits
      habits.commits.hour = hours.length ? `${Object.entries(habits.commits.hours).sort(([_an, a], [_bn, b]) => b - a).map(([hour, _occurrence]) => hour)[0]}`.padStart(2, "0") : NaN
    }

    //Indent style
    {
      //Attempt to guess whether tabs or spaces are used in patches
      console.debug(`metrics/compute/${login}/plugins > habits > searching indent style`)
      patches
        .map(({patch}) => patch.match(/((?:\t)|(?:[ ]{2})) /gm) ?? [])
        .forEach(indent => habits.indents[/^\t/.test(indent) ? "tabs" : "spaces"]++)
      habits.indents.style = habits.indents.spaces > habits.indents.tabs ? "spaces" : habits.indents.tabs > habits.indents.spaces ? "tabs" : ""
    }

    //Average characters per line
    {
      //Compute average number of characters per line of code fetched
      console.debug(`metrics/compute/${login}/plugins > habits > computing average number of characters per line of code`)
      const lines = patches.flatMap(({patch}) => patch.split("\n").map(line => line.length))
      habits.lines.average.chars = lines.reduce((a, b) => a + b, 0) / lines.length
    }

    //Linguist
    if ((charts) && (imports.metadata.plugins.habits.extras("charts", {extras, error: false}))) {
      //Check if linguist exists
      console.debug(`metrics/compute/${login}/plugins > habits > searching recently used languages using linguist`)
      if (patches.length) {
        //Call language analyzer (note: using content from other plugin is usually disallowed, this is mostly for legacy purposes)
        habits.linguist.available = true
        const {total, stats, colors} = await recent_analyzer({login, data, imports, rest, account}, {days, load: from || 1000, tempdir: "habits"})
        habits.linguist.languages = Object.fromEntries(Object.entries(stats).map(([language, value]) => [language, value / total]))
        habits.linguist.ordered = Object.entries(habits.linguist.languages).sort(([_an, a], [_bn, b]) => b - a).filter(([_, value]) => value > threshold).slice(0, limit || Infinity)
        habits.linguist.colors = colors
      }
      else {
        console.debug(`metrics/compute/${login}/plugins > habits > linguist not available`)
      }
    }

    //Generating charts
    if ((["graph", "chartist"].includes(_charts)) && (imports.metadata.plugins.habits.extras("charts.type", {extras}))) {
      console.debug(`metrics/compute/${login}/plugins > habits > generating charts`)
      habits.charts = await Promise.all([
        {type: "line", data: {...empty(24), ...Object.fromEntries(Object.entries(habits.commits.hours).filter(([k]) => !Number.isNaN(+k)))}, ticks: 24, low: 0, high: habits.commits.hours.max},
        {type: "line", data: {...empty(7), ...Object.fromEntries(Object.entries(habits.commits.days).filter(([k]) => !Number.isNaN(+k)))}, ticks: 7, low: 0, high: habits.commits.days.max, labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], half: true},
        {type: "pie", data: Object.fromEntries(Object.entries(habits.linguist.languages).map(([k, v]) => [k, (100 * v).toFixed(2)])), colors: habits.linguist.colors, half: true},
      ].map(({type, data, high, low, ticks, colors = null, labels = null, half = false}) => {
        const width = 480 * (half ? 0.45 : 1)
        const height = 160
        if (type === "line")
          return imports.Graph.line(Object.entries(data).map(([x, y]) => ({x: +x, y})), {low, high, ticks, labels, width, height})
        if (type === "pie")
          return imports.Graph.pie(data, {colors, width, height})
        return ""
      }))
    }

    //Results
    return habits
  }
  //Handle errors
  catch (error) {
    throw imports.format.error(error)
  }
}

/**Load recent commits from a bounded GitHub commit search */
async function searchRecentCommits({login, rest, days, skipped, imports}) {
  const now = new Date()
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const author = `author:${login}`
  let result = await searchCommits(rest, `${author} author-date:>=${since.toISOString().slice(0, 10)}`)

  //GitHub caps each search at 1,000 results, so retry large ranges one day at a time
  if (result.truncated) {
    const items = []
    const date = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    for (; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      const daily = await searchCommits(rest, `${author} author-date:${date.toISOString().slice(0, 10)}`)
      items.push(...daily.items)
    }
    result = {items}
  }

  const unique = new Map()
  for (const item of result.items) {
    const created_at = item.commit?.author?.date
    const repo = item.repository?.full_name
    if ((!item.sha) || (!created_at) || (!repo) || (new Date(created_at) <= since) || (new Date(created_at) > now) || (!imports.filters.repo(repo, skipped)))
      continue
    unique.set(item.sha, {created_at, repo})
  }
  return [...unique.values()]
}

/**Load all available pages for one commit search */
async function searchCommits(rest, q) {
  const options = {q, per_page: 100, sort: "author-date", order: "desc"}
  const {data: first} = await rest.search.commits({...options, page: 1})
  const items = [...(first.items ?? [])]
  const total = Number(first.total_count) || 0
  const pages = Math.min(Math.ceil(total / options.per_page), 10)
  for (let page = 2; page <= pages; page++) {
    const {data} = await rest.search.commits({...options, page})
    items.push(...(data.items ?? []))
  }
  return {items, truncated: Boolean(first.incomplete_results) || (total > 1000)}
}

/**Initialize an empty object with values from 0 to n */
function empty(n) {
  return Object.fromEntries(new Array(n).fill(0).map((_, i) => [i, 0]))
}
