import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFrontmatterKeyInventory,
  filesForFrontmatterKey,
  inferFrontmatterType,
  sortFrontmatterKeyEntries
} from "./frontmatterKeys.ts";

describe("inferFrontmatterType", () => {
  it("maps common YAML shapes to Properties-like types", () => {
    assert.equal(inferFrontmatterType(true), "checkbox");
    assert.equal(inferFrontmatterType(3), "number");
    assert.equal(inferFrontmatterType("2026-08-08"), "date");
    assert.equal(inferFrontmatterType("hello"), "text");
    assert.equal(inferFrontmatterType(["a", "b"]), "multitext");
  });
});

describe("buildFrontmatterKeyInventory", () => {
  it("counts notes once per key and sorts by count then name", () => {
    const entries = buildFrontmatterKeyInventory(
      [
        { path: "a.md", keys: ["type", "workspace", "type"] },
        { path: "b.md", keys: ["workspace"] },
        { path: "c.md", keys: ["date"] },
        { path: "empty.md", keys: [] }
      ],
      (name) => (name === "workspace" ? "text" : null),
      new Map<string, unknown>([
        ["type", "note"],
        ["workspace", "agentic-memory"],
        ["date", "2026-08-08"]
      ])
    );

    assert.deepEqual(entries, [
      { name: "workspace", count: 2, type: "text" },
      { name: "date", count: 1, type: "date" },
      { name: "type", count: 1, type: "text" }
    ]);
  });

  it("returns empty array when no properties exist", () => {
    assert.deepEqual(buildFrontmatterKeyInventory([], () => null), []);
    assert.deepEqual(
      buildFrontmatterKeyInventory([{ path: "a.md", keys: [] }], () => null),
      []
    );
  });
});

describe("filesForFrontmatterKey", () => {
  it("lists matching filenames sorted; unknown key is empty", () => {
    const notes = [
      { path: "B.md", keys: ["workspace"] },
      { path: "A.md", keys: ["workspace", "type"] },
      { path: "C.md", keys: ["type"] }
    ];
    assert.deepEqual(filesForFrontmatterKey(notes, "workspace"), [
      { filename: "A.md" },
      { filename: "B.md" }
    ]);
    assert.deepEqual(filesForFrontmatterKey(notes, "missing"), []);
    assert.deepEqual(filesForFrontmatterKey(notes, "  "), []);
  });
});

describe("sortFrontmatterKeyEntries", () => {
  it("is stable for equal counts", () => {
    const sorted = sortFrontmatterKeyEntries([
      { name: "zeta", count: 1, type: "text" },
      { name: "alpha", count: 1, type: "text" },
      { name: "mid", count: 5, type: "text" }
    ]);
    assert.deepEqual(
      sorted.map((e) => e.name),
      ["mid", "alpha", "zeta"]
    );
  });
});
