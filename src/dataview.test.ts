import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractPath,
  extractPaths,
  isDataviewQuery,
  toDataviewQuery
} from "./dataview.ts";

describe("isDataviewQuery / toDataviewQuery", () => {
  it("detects LIST/TABLE/TASK/CALENDAR prefixes", () => {
    assert.equal(isDataviewQuery("LIST FROM #tag"), true);
    assert.equal(isDataviewQuery("table file.name from \"Projects\""), true);
    assert.equal(isDataviewQuery("TASK WHERE !completed"), true);
    assert.equal(isDataviewQuery("CALENDAR file.ctime"), true);
    assert.equal(isDataviewQuery("#research"), false);
    assert.equal(isDataviewQuery("\"Projects\""), false);
  });

  it("passes full queries through and wraps bare sources", () => {
    assert.equal(toDataviewQuery("LIST FROM #tag"), "LIST FROM #tag");
    assert.equal(toDataviewQuery("#research"), "LIST FROM #research");
    assert.equal(
      toDataviewQuery("#research or \"Projects\""),
      "LIST FROM #research or \"Projects\""
    );
    assert.equal(toDataviewQuery("  \"Knowledge\"  "), "LIST FROM \"Knowledge\"");
  });
});

describe("extractPath", () => {
  it("prefers file.path then path; never follows value", () => {
    assert.equal(extractPath({ file: { path: "a.md" }, path: "b.md" }), "a.md");
    assert.equal(extractPath({ path: "note.md" }), "note.md");

    const cyclic: { value?: unknown; path?: string } = {};
    cyclic.value = cyclic;
    assert.equal(extractPath(cyclic), null);

    // DataArray-like: truthy .value must not be followed
    const dataArrayLike = {
      value: { value: { value: { path: "never.md" } } },
      path: undefined as string | undefined
    };
    assert.equal(extractPath(dataArrayLike), null);
  });
});

describe("extractPaths", () => {
  it("collects Link paths from arrays and nested list shapes", () => {
    const rows = [{ path: "Daily/x.md" }, { file: { path: "Knowledge/y.md" } }];
    assert.deepEqual([...extractPaths(rows)].sort(), ["Daily/x.md", "Knowledge/y.md"]);
    assert.deepEqual(
      [...extractPaths({ rows })].sort(),
      ["Daily/x.md", "Knowledge/y.md"]
    );
  });

  it("materializes DataArray-like via .array() and ignores .value", () => {
    const pages = [{ path: "a.md" }, { path: "b.md" }];
    const dataArray: { array: () => unknown[]; value?: unknown } = {
      array: () => pages
    };
    dataArray.value = dataArray;

    assert.deepEqual([...extractPaths(dataArray)].sort(), ["a.md", "b.md"]);

    const cycle: { value?: unknown } = {};
    cycle.value = cycle;
    // .value is never walked — cycle object yields no paths and does not throw
    assert.deepEqual([...extractPaths(cycle)], []);
  });

  it("does not recurse forever on nested DataArray .value Proxies", () => {
    let depth = 0;
    const makeProxy = (): object =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "value") {
              depth += 1;
              if (depth > 20) throw new Error("too deep — extractPaths followed .value");
              return makeProxy();
            }
            return undefined;
          }
        }
      );

    assert.doesNotThrow(() => extractPaths(makeProxy()));
    assert.equal(depth, 0);
  });
});
