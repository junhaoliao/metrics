/**Wait for the requested number of seconds */
export async function wait(seconds) {
  await new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/**Retry a task a fixed number of times */
export async function retry(func, {retries = 1, delay = 0, sleep = wait} = {}) {
  let error = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.debug(`::group::Attempt ${attempt}/${retries}`)
      const result = await func()
      console.debug("::endgroup::")
      return result
    }
    catch (_error) {
      error = _error
      console.debug("::endgroup::")
      console.debug(`::warning::${error.message}`)
      if (attempt < retries)
        await sleep(delay)
    }
  }
  if (error)
    throw error
  return null
}

/**Check whether an API error is a GitHub secondary rate limit */
export function isSecondaryRateLimit(error) {
  const status = Number(error?.status ?? error?.response?.status)
  const retryAfter = header(error, "retry-after")
  const details = [error?.message, error?.response?.data?.message, error?.response?.data?.documentation_url].filter(Boolean).join(" ")
  return (status === 429) || ((status === 403) && ((retryAfter !== undefined) || /secondary rate limit|abuse detection/i.test(details)))
}

/**Retry the same GraphQL request after a GitHub secondary rate limit */
export function withGraphqlRetries(graphql, {retries = 2, sleep = wait, random = Math.random} = {}) {
  const wrapped = async function(...args) {
    for (let attempt = 0;; attempt++) {
      try {
        return await graphql(...args)
      }
      catch (error) {
        if ((!isSecondaryRateLimit(error)) || (attempt >= retries))
          throw error
        const retryAfter = Number(header(error, "retry-after"))
        const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60
        const delay = Math.min(base * (2 ** attempt), 15 * 60) + Math.ceil(random() * 5)
        console.warn(`GitHub secondary rate limit reached; retrying the same GraphQL request in ${delay}s`)
        await sleep(delay)
      }
    }
  }
  return Object.assign(wrapped, graphql)
}

function header(error, name) {
  const headers = error?.response?.headers
  return headers?.[name] ?? headers?.[name.toLocaleLowerCase()] ?? headers?.get?.(name)
}
