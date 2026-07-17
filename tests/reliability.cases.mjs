import assert from "node:assert/strict"
import {mapSettled} from "../source/app/concurrency.mjs"
import {retry, withGraphqlRetries} from "../source/app/retry.mjs"

{
  const calls = []
  const delays = []
  let attempt = 0
  const secondaryRateLimit = Object.assign(new Error("You have exceeded a secondary rate limit"), {
    status: 403,
    response: {
      status: 403,
      headers: {"retry-after": "60"},
      data: {message: "You have exceeded a secondary rate limit"},
    },
  })
  const graphql = withGraphqlRetries(async (...args) => {
    calls.push(args)
    if (attempt++ === 0)
      throw secondaryRateLimit
    return {viewer: {login: "metrics-test"}}
  }, {
    retries: 2,
    random: () => 0,
    sleep: async seconds => delays.push(seconds),
  })

  assert.deepEqual(await graphql("query", {login: "metrics-test"}), {viewer: {login: "metrics-test"}})
  assert.deepEqual(calls, [["query", {login: "metrics-test"}], ["query", {login: "metrics-test"}]])
  assert.deepEqual(delays, [60])
}

{
  const error = Object.assign(new Error("Resource not accessible by personal access token"), {status: 403})
  let attempts = 0
  const graphql = withGraphqlRetries(async () => {
    attempts++
    throw error
  }, {sleep: async () => assert.fail("non-rate-limit errors must not wait")})

  await assert.rejects(graphql("query"), candidate => candidate === error)
  assert.equal(attempts, 1)
}

{
  const error = new Error("render failed")
  const delays = []
  let attempts = 0
  await assert.rejects(retry(async () => {
    attempts++
    throw error
  }, {retries: 3, delay: 5, sleep: async seconds => delays.push(seconds)}), candidate => candidate === error)
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [5, 5])
}

{
  let active = 0
  let maximum = 0
  const results = await mapSettled(Array.from({length: 12}, (_, index) => index), async index => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 1))
    active--
    if (index === 5)
      throw new Error("expected failure")
    return index * 2
  }, {concurrency: 3})

  assert.equal(maximum, 3)
  assert.equal(results.length, 12)
  assert.deepEqual(results[4], {status: "fulfilled", value: 8})
  assert.equal(results[5].status, "rejected")
  assert.equal(results[6].value, 12)
}
