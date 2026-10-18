const assert = require("node:assert/strict");
const { readCatalog } = require("../runtime/model-catalog.cjs");
(async () => {
  const calls = [];
  let generation = 0;
  const server = {
    request: async (method, params) => {
      calls.push({ method, params });
      return params.cursor
        ? {
            data: [
              {
                model: "second-" + generation,
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
              { model: "hidden", hidden: true },
            ],
            nextCursor: null,
          }
        : {
            data: [
              { model: "first-" + generation, isDefault: true },
              { model: "first-" + generation, isDefault: true },
            ],
            nextCursor: "page-two",
          };
    },
  };
  const first = await readCatalog(server);
  assert.deepEqual(
    first.map((m) => m.model),
    ["first-0", "second-0"],
  );
  generation = 1;
  const second = await readCatalog(server);
  assert.deepEqual(
    second.map((m) => m.model),
    ["first-1", "second-1"],
  );
  assert.equal(second[1].supportedReasoningEfforts[0].reasoningEffort, "high");
  assert.equal(calls[1].params.cursor, "page-two");
  assert.ok(
    calls.every(
      (c) => c.method === "model/list" && c.params.includeHidden === false,
    ),
  );
  await assert.rejects(
    readCatalog({ request: async () => ({ data: [], nextCursor: "loop" }) }),
    /pagination/,
  );
  console.log(
    "PASS: current CLI catalog replaces stale models, complete pagination, account/client changes, capabilities and hidden-model filtering.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
