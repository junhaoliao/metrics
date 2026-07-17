/**Map values with bounded concurrency while preserving Promise.allSettled semantics */
export async function mapSettled(values, mapper, {concurrency = 8} = {}) {
  values = Array.from(values)
  const results = new Array(values.length)
  const requested = Number(concurrency)
  const workers = Math.min(values.length, Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1)
  let next = 0

  await Promise.all(Array.from({length: workers}, async () => {
    while (next < values.length) {
      const index = next++
      try {
        results[index] = {status: "fulfilled", value: await mapper(values[index], index, values)}
      }
      catch (reason) {
        results[index] = {status: "rejected", reason}
      }
    }
  }))

  return results
}
