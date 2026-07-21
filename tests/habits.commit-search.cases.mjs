import assert from "node:assert/strict"
import habits from "../source/plugins/habits/index.mjs"

const now = new Date()
const authored = Array.from({length: 101}, (_, index) => {
  const date = new Date(now.getTime() - (2 + (index % 10)) * 24 * 60 * 60 * 1000)
  date.setUTCHours(index % 24, 0, 0, 0)
  return date
})

const eventDate = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
const eventCalls = []
const searchCalls = []
const result = await habits({
  login: "metrics-test",
  q: {habits: true},
  data: {
    config: {timezone: {offset: 0}},
    shared: {"commits.authoring": ["metrics-test"], "repositories.skipped": []},
  },
  rest: {
    activity: {
      listEventsForAuthenticatedUser: async options => {
        eventCalls.push(options)
        return {
          data: [{
            type: "PushEvent",
            actor: {login: "metrics-test"},
            repo: {name: "example/project"},
            payload: {commits: []},
            created_at: eventDate,
          }],
        }
      },
    },
    search: {
      commits: async options => {
        searchCalls.push(options)
        const start = (options.page - 1) * options.per_page
        const page = authored.slice(start, start + options.per_page)
        return {
          data: {
            total_count: authored.length,
            incomplete_results: false,
            items: page.map(date => ({
              sha: `commit-${authored.indexOf(date)}`,
              repository: {full_name: "example/project"},
              commit: {author: {date: date.toISOString()}},
            })),
          },
        }
      },
    },
    request: async () => assert.fail("commit details are not needed for chart aggregation"),
  },
  imports: {
    metadata: {
      plugins: {
        habits: {
          enabled: () => true,
          inputs: () => ({from: 800, days: 14, facts: true, charts: false, "charts.type": "classic", trim: false, "languages.limit": 8, "languages.threshold": "0%", skipped: []}),
        },
      },
    },
    filters: {repo: () => true},
    format: {error: error => error},
    paths: {basename: value => value},
  },
  account: "user",
}, {enabled: true})

assert.equal(eventCalls.length, 3)
assert.equal(searchCalls.length, 2)
assert.match(searchCalls[0].q, /^author:metrics-test author-date:>=\d{4}-\d{2}-\d{2}$/)
assert.equal(searchCalls[0].per_page, 100)
assert.equal(result.commits.fetched, authored.length)
const expectedHours = {}
const expectedDays = {}
for (const date of authored) {
  expectedHours[date.getHours()] = (expectedHours[date.getHours()] ?? 0) + 1
  expectedDays[date.getDay()] = (expectedDays[date.getDay()] ?? 0) + 1
}
expectedHours.max = Math.max(...Object.values(expectedHours))
expectedDays.max = Math.max(...Object.values(expectedDays))
assert.deepEqual(result.commits.hours, expectedHours)
assert.deepEqual(result.commits.days, expectedDays)
