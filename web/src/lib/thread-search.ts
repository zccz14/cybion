export function matchesThreadQuery(thread: { title: string }, query: string) {
  return thread.title.toLowerCase().includes(query.trim().toLowerCase())
}
