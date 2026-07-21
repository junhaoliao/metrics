/**Mocked data */
export default async function({faker}, target, that, [{q, page, per_page}]) {
  console.debug("metrics/compute/mocks > mocking rest api result > rest.search.commits")
  const items = page === 1 ? [{
    sha: faker.git.commitSha(),
    repository: {full_name: "lowlighter/metrics"},
    commit: {author: {date: faker.date.recent({days: 7}).toISOString()}},
  }] : []
  return ({
    status: 200,
    url: `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=${per_page}&page=${page}`,
    headers: {
      server: "GitHub.com",
      status: "200 OK",
      "x-oauth-scopes": "repo",
    },
    data: {total_count: items.length, incomplete_results: false, items},
  })
}
