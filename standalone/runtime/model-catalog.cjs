// Read the complete account-specific catalog; never merge it with stale built-ins.
async function readCatalog(client) {
  const models = [],
    seen = new Set();
  let cursor, pages = 0;
  do {
    const result = await client.request("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.data)) throw Error("Invalid CLI model catalog");
    models.push(...result.data);
    cursor = result.nextCursor;
    pages++;
    if (cursor && (!result.data.length || pages >= 50 || typeof cursor !== 'string' || seen.has(cursor) || models.length > 5000))
      throw Error("Invalid model catalog pagination");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [
    ...new Map(
      models
        .filter((m) => typeof m.model === "string" && !m.hidden)
        .map((m) => [m.model, m]),
    ).values(),
  ];
}
module.exports = { readCatalog };
