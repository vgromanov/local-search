import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dataviewIndexReady,
  executeDataviewQuery,
  isIndexReady,
  type DataviewQueryContext
} from "./dataviewQuery.ts";

const readyIndex = { index: { initialized: true } };
const readyCache = { metadataCache: { initialized: true, inProgressTaskCount: 0 } };

function ctx(
  query: DataviewQueryContext["query"],
  overrides: Partial<DataviewQueryContext> = {}
): DataviewQueryContext {
  return {
    query,
    indexReady: true,
    maxRows: 5_000,
    maxTimeoutMs: 30_000,
    ...overrides
  };
}

function link(path: string): { path: string; type: "file" } {
  return { path, type: "file" };
}

async function run(query: DataviewQueryContext["query"], body: unknown, overrides?: Partial<DataviewQueryContext>) {
  return executeDataviewQuery(ctx(query, overrides), body);
}

describe("POST /dataview/query/", () => {
  it("returns table rows keyed by header, with File as a path", async () => {
    const outcome = await run(async () => ({
      successful: true,
      value: {
        type: "table",
        headers: ["File", "status"],
        idMeaning: { type: "path" },
        values: [
          [link("Projects/b.md"), "draft"],
          [link("Projects/a.md"), { isLuxonDateTime: true, toISO: () => "2020-01-02T03:04:05.000Z" }]
        ]
      }
    }), { query: "TABLE status" });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.body, {
      type: "table",
      headers: ["File", "status"],
      rows: [
        { file: "Projects/a.md", status: "2020-01-02T03:04:05.000Z" },
        { file: "Projects/b.md", status: "draft" }
      ],
      truncated: false,
      index_ready: true
    });
  });

  it("returns list items and task projections", async () => {
    const list = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        values: [link("b.md"), link("a.md")],
        primaryMeaning: { type: "path" }
      }
    }), { query: "LIST" });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    assert.deepEqual(list.body.items, ["a.md", "b.md"]);

    const tasks = await run(async () => ({
      successful: true,
      value: {
        type: "task",
        values: [
          { link: link("b.md"), line: 4, text: "beta", completed: false, status: " " },
          {
            path: "a.md",
            line: 2,
            text: "alpha",
            completed: true,
            status: "x",
            section: { path: "a.md", type: "header", subpath: "Plan" }
          }
        ]
      }
    }), { query: "TASK" });
    assert.equal(tasks.ok, true);
    if (!tasks.ok) return;
    assert.deepEqual(tasks.body.tasks, [
      { path: "a.md", line: 2, text: "alpha", completed: true, status: "x", section: "Plan" },
      { path: "b.md", line: 4, text: "beta", completed: false, status: " " }
    ]);
    assert.equal(Object.hasOwn(tasks.body.tasks[1] as object, "section"), false);
  });

  it("shapes GROUP BY as { key, rows } for tables, lists, and tasks", async () => {
    const table = await run(async () => ({
      successful: true,
      value: {
        type: "table",
        headers: ["status", "File"],
        idMeaning: { type: "group", name: "status", on: { type: "path" } },
        values: [
          ["ready", link("z.md")],
          ["draft", link("a.md")]
        ]
      }
    }), { query: "TABLE file.link GROUP BY status" });
    assert.equal(table.ok, true);
    if (!table.ok) return;
    assert.deepEqual(table.body.rows, [
      { key: "draft", rows: [{ file: "a.md" }] },
      { key: "ready", rows: [{ file: "z.md" }] }
    ]);

    const list = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        primaryMeaning: { type: "group", name: "status", on: { type: "path" } },
        values: [
          { key: "ready", rows: [link("c.md"), link("a.md")] },
          { key: "draft", rows: [link("b.md")] }
        ]
      }
    }), { query: "LIST GROUP BY status" });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    assert.deepEqual(list.body.items, [
      { key: "ready", rows: ["a.md", "c.md"] },
      { key: "draft", rows: ["b.md"] }
    ]);

    const nested = await run(async () => ({
      successful: true,
      value: {
        type: "task",
        values: [
          {
            key: "open",
            rows: [
              {
                key: "b.md",
                rows: [{ path: "b.md", line: 1, text: "one", completed: false, status: " " }]
              }
            ]
          }
        ]
      }
    }), { query: "TASK GROUP BY status" });
    assert.equal(nested.ok, true);
    if (!nested.ok) return;
    assert.deepEqual(nested.body.tasks, [
      {
        key: "open",
        rows: [
          {
            key: "b.md",
            rows: [{ path: "b.md", line: 1, text: "one", completed: false, status: " " }]
          }
        ]
      }
    ]);
  });

  it("accepts FLATTEN and serializes expanded rows", async () => {
    let seen = "";
    const outcome = await run(async (source) => {
      seen = source;
      return {
        successful: true,
        value: {
          type: "table",
          headers: ["File", "item"],
          idMeaning: { type: "path" },
          values: [
            [link("a.md"), "one"],
            [link("a.md"), ["nested", "still"]]
          ]
        }
      };
    }, { query: "TABLE item FROM \"Projects\" FLATTEN items AS item" });

    assert.equal(seen, "TABLE item FROM \"Projects\" FLATTEN items AS item");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.body.rows, [
      { file: "a.md", item: "one" },
      { file: "a.md", item: ["nested", "still"] }
    ]);
  });

  it("accepts a link hop and serializes link values as paths", async () => {
    let seen = "";
    const outcome = await run(async (source) => {
      seen = source;
      return {
        successful: true,
        value: {
          type: "table",
          headers: ["File", "link(d).status"],
          idMeaning: { type: "path" },
          values: [
            [link("b.md"), "ready"],
            [link("a.md"), link("Projects/upstream.md")]
          ]
        }
      };
    }, { query: "TABLE link(d).status FROM \"Projects\"" });

    assert.equal(seen, "TABLE link(d).status FROM \"Projects\"");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.body.rows, [
      { file: "a.md", "link(d).status": "Projects/upstream.md" },
      { file: "b.md", "link(d).status": "ready" }
    ]);
  });

  it("returns the Dataview parse error verbatim", async () => {
    const message = "Expected one of: TABLE, LIST, TASK, CALENDAR at line 1, column 4";
    const outcome = await run(async () => ({ successful: false, error: message }), {
      query: "TABLE @"
    });
    assert.deepEqual(outcome, { ok: false, status: 400, message });
  });

  it("rejects CALENDAR, dataviewjs, inline JS, and JavaScript expressions before execution", async () => {
    const cases: Array<[string, string]> = [
      ["CALENDAR file.day", "CALENDAR queries are not supported"],
      ["dataviewjs\ndv.pages()", "dataviewjs is not supported"],
      ["$= dv.pages(\"#tag\")", "Inline JavaScript ($=) is not supported"],
      ["dv.pages(\"#tag\").map(p => p.file.path)", "JavaScript expressions are not supported"],
      ["function listPages() { return 1 }", "JavaScript expressions are not supported"],
      ["FROM \"Projects\"", "Only TABLE, LIST, and TASK queries are supported"]
    ];
    for (const [query, message] of cases) {
      let called = false;
      const outcome = await run(async () => {
        called = true;
        return { successful: true, value: { type: "list", values: [] } };
      }, { query });
      assert.equal(called, false, query);
      assert.deepEqual(outcome, { ok: false, status: 400, message });
    }
  });

  it("does not treat quoted syntax as JavaScript or as SORT", async () => {
    const queries = [
      "TABLE file.name WHERE contains(file.name, \"$=\")",
      "TABLE file.name WHERE name = \"dataviewjs\"",
      "TABLE file.name WHERE name = \"function\"",
      "TABLE file.name WHERE name = \"foo\\\" SORT\""
    ];
    for (const query of queries) {
      let seen = "";
      const outcome = await run(async (source) => {
        seen = source;
        return {
          successful: true,
          value: {
            type: "table",
            headers: ["File"],
            idMeaning: { type: "path" },
            values: [[link("z.md")], [link("a.md")]]
          }
        };
      }, { query });
      assert.equal(seen, query);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.deepEqual(
        (outcome.body.rows as Array<{ file: string }>).map((row) => row.file),
        ["a.md", "z.md"]
      );
    }
  });

  it("ignores // comments and keeps // inside quotes", async () => {
    const commented = [
      "LIST FROM #tag // dataviewjs $= => function evil()",
      "// dataviewjs\nLIST FROM #tag",
      "LIST // SORT file.name DESC"
    ];
    for (const query of commented) {
      let seen = "";
      const outcome = await run(async (source) => {
        seen = source;
        return {
          successful: true,
          value: {
            type: "list",
            values: ["z.md", "a.md"],
            primaryMeaning: { type: "path" }
          }
        };
      }, { query });
      assert.equal(seen, query);
      assert.equal(outcome.ok, true, query);
      if (!outcome.ok) return;
      assert.deepEqual(outcome.body.items, ["a.md", "z.md"]);
    }

    const sorted = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        values: ["z.md", "a.md"],
        primaryMeaning: { type: "path" }
      }
    }), { query: "LIST WHERE name = \"http://example.com\" SORT file.name DESC" });
    assert.equal(sorted.ok, true);
    if (!sorted.ok) return;
    assert.deepEqual(sorted.body.items, ["z.md", "a.md"]);
  });

  it("accepts tags, paths, and fields that contain function", async () => {
    const queries = [
      "LIST FROM #function",
      "LIST FROM my-function",
      "TABLE file.function FROM \"Notes/my-function\""
    ];
    for (const query of queries) {
      let seen = "";
      const outcome = await run(async (source) => {
        seen = source;
        return {
          successful: true,
          value: { type: "list", values: ["a.md"], primaryMeaning: { type: "path" } }
        };
      }, { query });
      assert.equal(seen, query);
      assert.equal(outcome.ok, true);
    }
  });

  it("keeps Dataview order when the query has SORT", async () => {
    const outcome = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        values: ["z.md", "a.md"],
        primaryMeaning: { type: "path" }
      }
    }), { query: "LIST SORT file.name DESC" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.body.items, ["z.md", "a.md"]);
  });

  it("caps rows and reports truncation, including the settings hard max", async () => {
    const values = ["c.md", "a.md", "b.md"];
    const limited = await run(async () => ({
      successful: true,
      value: { type: "list", values, primaryMeaning: { type: "path" } }
    }), { query: "LIST", limit: 2 });
    assert.equal(limited.ok, true);
    if (!limited.ok) return;
    assert.deepEqual(limited.body.items, ["a.md", "b.md"]);
    assert.equal(limited.body.truncated, true);

    const clamped = await run(async () => ({
      successful: true,
      value: { type: "list", values, primaryMeaning: { type: "path" } }
    }), { query: "LIST", limit: 100 }, { maxRows: 1 });
    assert.equal(clamped.ok, true);
    if (!clamped.ok) return;
    assert.deepEqual(clamped.body.items, ["a.md"]);
    assert.equal(clamped.body.truncated, true);

    const grouped = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        values: [
          { key: "ready", rows: [link("c.md"), link("a.md")] },
          { key: "draft", rows: [link("d.md"), link("b.md")] }
        ]
      }
    }), { query: "LIST GROUP BY status", limit: 3 });
    assert.equal(grouped.ok, true);
    if (!grouped.ok) return;
    assert.deepEqual(grouped.body.items, [
      { key: "ready", rows: ["a.md", "c.md"] },
      { key: "draft", rows: ["b.md"] }
    ]);
    assert.equal(grouped.body.truncated, true);
  });

  it("returns 503 when Dataview is absent", async () => {
    const outcome = await run(null, { query: "LIST" });
    assert.deepEqual(outcome, {
      ok: false,
      status: 503,
      message: "Dataview plugin is not available"
    });
  });

  it("returns 408 with no rows when the query exceeds timeout_ms", async () => {
    let resolveLate: (value: unknown) => void = () => {};
    const pending = run(
      () => new Promise((resolve) => {
        resolveLate = resolve;
      }),
      { query: "LIST", timeout_ms: 20 }
    );
    const outcome = await pending;
    resolveLate({
      successful: true,
      value: { type: "list", values: ["late.md"], primaryMeaning: { type: "path" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(outcome, { ok: false, status: 408, message: "Dataview query timed out" });
    assert.equal(JSON.stringify(outcome).includes("late.md"), false);
  });

  it("clamps timeout_ms to the settings hard max", async () => {
    const started = Date.now();
    const outcome = await run(
      () => new Promise(() => {}),
      { query: "LIST", timeout_ms: 10_000 },
      { maxTimeoutMs: 30 }
    );
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(outcome, { ok: false, status: 408, message: "Dataview query timed out" });
  });

  it("reads DataArray rows via .array() and never .value", async () => {
    let valueReads = 0;
    const values = {
      array: () => [[link("a.md"), "ok"]],
      get value() {
        valueReads += 1;
        throw new Error("followed value");
      }
    };
    const outcome = await run(async () => ({
      successful: true,
      value: {
        type: "table",
        headers: ["File", "status"],
        idMeaning: { type: "path" },
        values
      }
    }), { query: "TABLE status" });
    assert.equal(valueReads, 0);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.body.rows, [{ file: "a.md", status: "ok" }]);
  });

  it("rejects invalid limits, timeouts, and query fields", async () => {
    const invalid: Array<[unknown, string]> = [
      [{ query: "LIST", limit: 0 }, "`limit` must be a positive number"],
      [{ query: "LIST", limit: -3 }, "`limit` must be a positive number"],
      [{ query: "LIST", limit: "2" }, "`limit` must be a positive number"],
      [{ query: "LIST", timeout_ms: 0 }, "`timeout_ms` must be a positive number"],
      [{ query: "" }, "`query` must be a string"],
      [{ query: 12 }, "`query` must be a string"],
      [[], "`query` must be a string"]
    ];
    for (const [body, message] of invalid) {
      const outcome = await run(async () => ({ successful: true, value: { type: "list", values: [] } }), body);
      assert.deepEqual(outcome, { ok: false, status: 400, message });
    }
  });

  it("passes index_ready through and reports query failures", async () => {
    const stale = await run(async () => ({
      successful: true,
      value: { type: "list", values: [], primaryMeaning: { type: "path" } }
    }), { query: "LIST" }, { indexReady: false });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    assert.equal(stale.body.index_ready, false);

    const thrown = await run(async () => {
      throw new Error("boom");
    }, { query: "LIST" });
    assert.deepEqual(thrown, { ok: false, status: 500, message: "boom" });

    const nonError = await run(async () => {
      throw "nope";
    }, { query: "LIST" });
    assert.deepEqual(nonError, { ok: false, status: 500, message: "Dataview query failed" });

    const empty = await run(async () => null, { query: "LIST" });
    assert.deepEqual(empty, { ok: false, status: 400, message: "Dataview query failed" });

    const calendar = await run(async () => ({
      successful: true,
      value: { type: "calendar", values: [] }
    }), { query: "TABLE file.day" });
    assert.deepEqual(calendar, {
      ok: false,
      status: 400,
      message: "CALENDAR queries are not supported"
    });
  });

  it("serializes an ungrouped list pair and a grouped list key", async () => {
    class ListPairWidget {
      key: unknown;
      value: unknown;
      constructor(key: unknown, value: unknown) {
        this.key = key;
        this.value = value;
      }
    }

    const pairs = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        primaryMeaning: { type: "path" },
        values: [new ListPairWidget(link("a.md"), "ready")]
      }
    }), { query: "LIST status" });
    assert.equal(pairs.ok, true);
    if (!pairs.ok) return;
    assert.deepEqual(pairs.body.items, [{ key: "a.md", value: "ready" }]);

    const keys = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        primaryMeaning: { type: "group", name: "status", on: { type: "path" } },
        values: ["ready", "draft"]
      }
    }), { query: "LIST GROUP BY status" });
    assert.equal(keys.ok, true);
    if (!keys.ok) return;
    assert.deepEqual(keys.body.items, [
      { key: "ready", rows: [] },
      { key: "draft", rows: [] }
    ]);

    const groupedPair = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        primaryMeaning: { type: "group", name: "status", on: { type: "path" } },
        values: [{ key: "ready", value: link("a.md") }]
      }
    }), { query: "LIST status GROUP BY status" });
    assert.equal(groupedPair.ok, true);
    if (!groupedPair.ok) return;
    assert.deepEqual(groupedPair.body.items, [
      { key: "ready", rows: ["a.md"] }
    ]);
  });

  it("suffixes duplicate headers and ignores a broken DataArray", async () => {
    const dup = await run(async () => ({
      successful: true,
      value: {
        type: "table",
        headers: ["File", "file"],
        idMeaning: { type: "path" },
        values: [[link("a.md"), "other"]]
      }
    }), { query: "TABLE file" });
    assert.equal(dup.ok, true);
    if (!dup.ok) return;
    assert.deepEqual(dup.body.rows, [{ file: "a.md", file_2: "other" }]);

    const broken = await run(async () => ({
      successful: true,
      value: {
        type: "list",
        values: {
          get array() {
            throw new Error("trap");
          }
        }
      }
    }), { query: "LIST" });
    assert.equal(broken.ok, true);
    if (!broken.ok) return;
    assert.deepEqual(broken.body.items, []);
  });
});

describe("dataview index readiness", () => {
  it("requires an initialized Dataview index and a settled metadata cache", () => {
    assert.equal(dataviewIndexReady(readyCache, readyIndex), true);
    assert.equal(dataviewIndexReady(readyCache, null), false);
    assert.equal(dataviewIndexReady({ metadataCache: null }, readyIndex), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: false },
      metadataCache: { initialized: true }
    }), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: { initialized: false, inProgressTaskCount: 0 }
    }), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: { initialized: true, inProgressTaskCount: 2 }
    }), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: { queue: ["pending"] }
    }), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: { queue: { length: 0 } }
    }), true);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: { queue: { queue: ["one"] } }
    }), false);
    assert.equal(isIndexReady({
      dataviewIndex: { initialized: true },
      metadataCache: {}
    }), true);
  });
});
