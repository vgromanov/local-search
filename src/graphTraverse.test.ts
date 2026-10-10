import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { App, CachedMetadata, EmbedCache, HeadingCache, LinkCache, Pos } from "obsidian";

import { BODY_SOURCE, createLinkGraphIndex, type LinkGraphHost } from "./graph.ts";
import { DEFAULT_MAX_STRING_LENGTH } from "./serialize.ts";
import {
  GRAPH_TRAVERSE_PATH,
  MAX_LIMIT_NODES,
  bodyExcludingFrontmatter,
  executeGraphTraverse,
  graphIndexReady,
  openGraphTraverse,
  readVaultNote,
  registerGraphTraverseRoute,
  type GraphTraverseDeps,
  type GraphTraverseResponse,
  type NoteView
} from "./graphTraverse.ts";

function at(offset: number, end = offset + 1): Pos {
  return {
    start: { line: 0, col: 0, offset },
    end: { line: 0, col: 0, offset: end }
  };
}

function heading(text: string, level: number, offset: number): HeadingCache {
  return { heading: text, level, position: at(offset) };
}

function link(dest: string, offset: number): LinkCache {
  return { link: dest, original: `[[${dest}]]`, position: at(offset) };
}

function embed(dest: string, offset: number): EmbedCache {
  return { link: dest, original: `![[${dest}]]`, position: at(offset) };
}

function fm(frontmatter: Record<string, unknown>, extra: Partial<CachedMetadata> = {}): CachedMetadata {
  return { frontmatter, ...extra };
}

interface FakeFile {
  path: string;
  cache: CachedMetadata | null;
}

function createIndex(
  files: FakeFile[],
  resolve?: (linkpath: string, sourcePath: string) => string | null
) {
  const host: LinkGraphHost = {
    listMarkdownPaths: () => files.map((file) => file.path),
    getCache: (path) => files.find((file) => file.path === path)?.cache ?? null,
    resolveLink: (linkpath, sourcePath) => resolve?.(linkpath, sourcePath) ?? null,
    subscribe: () => () => {}
  };
  return createLinkGraphIndex(host);
}

function deps(
  files: FakeFile[],
  notes: Record<string, NoteView> = {},
  extra: Partial<GraphTraverseDeps> = {}
): GraphTraverseDeps {
  return {
    index: createIndex(files),
    indexReady: () => true,
    readNote: (path) => notes[path] ?? null,
    ...extra
  };
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: "",
    id_field: "id",
    edges: [{ source: "depends_on" }],
    direction: "out",
    ...extra
  };
}

async function ok(
  files: FakeFile[],
  body: Record<string, unknown>,
  notes: Record<string, NoteView> = {},
  extra: Partial<GraphTraverseDeps> = {}
): Promise<GraphTraverseResponse> {
  const outcome = await executeGraphTraverse(deps(files, notes, extra), body);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.body;
}

describe("graph traverse directions", () => {
  const files: FakeFile[] = [
    { path: "a.md", cache: fm({ id: "a", depends_on: ["b", "c"] }) },
    { path: "b.md", cache: fm({ id: "b", depends_on: "d" }) },
    { path: "c.md", cache: fm({ id: "c", depends_on: "d" }) },
    { path: "d.md", cache: fm({ id: "d" }) },
    { path: "e.md", cache: fm({ id: "e", depends_on: "a" }) }
  ];

  it("follows outgoing edges and keeps the shorter diamond depth", async () => {
    const body = await ok(files, request({ start: ["a"] }));
    assert.deepEqual(body.nodes.map((node) => [node.id, node.depth]), [
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["d", 2]
    ]);
    assert.deepEqual(body.edges, [
      { from: "a", to: "b", source: "depends_on" },
      { from: "a", to: "c", source: "depends_on" },
      { from: "b", to: "d", source: "depends_on" },
      { from: "c", to: "d", source: "depends_on" }
    ]);
    assert.deepEqual(body.cycles, []);
    assert.equal(body.truncated, false);
    assert.equal(body.nodes.some((node) => node.id === "e"), false);
  });

  it("walks reverse edges to transitive dependents", async () => {
    const body = await ok(files, request({ start: ["d"], direction: "in" }));
    assert.deepEqual(body.nodes.map((node) => [node.id, node.depth]), [
      ["d", 0],
      ["b", 1],
      ["c", 1],
      ["a", 2],
      ["e", 3]
    ]);
    assert.equal(body.edges.some((edge) => edge.from === "e" && edge.to === "a"), true);
  });

  it("walks either direction from the middle of a chain", async () => {
    const body = await ok(files, request({ start: ["b"], direction: "both" }));
    assert.deepEqual(body.nodes.map((node) => [node.id, node.depth]), [
      ["b", 0],
      ["a", 1],
      ["d", 1],
      ["c", 2],
      ["e", 2]
    ]);
    assert.deepEqual(body.cycles, []);
  });

  it("stops at max_depth and still reports edges between the visited nodes", async () => {
    const body = await ok(files, request({ start: ["a"], max_depth: 1 }));
    assert.deepEqual(body.nodes.map((node) => node.id), ["a", "b", "c"]);
    assert.equal(body.edges.some((edge) => edge.to === "d"), false);
  });

  it("keeps an edge between two starts when max_depth is 0", async () => {
    const body = await ok(files, request({ start: ["a", "b"], max_depth: 0 }));
    assert.deepEqual(body.nodes.map((node) => node.depth), [0, 0]);
    assert.deepEqual(body.edges, [{ from: "a", to: "b", source: "depends_on" }]);
  });

  it("resolves a start path and ignores a repeated start", async () => {
    const body = await ok(files, request({ start: ["b.md", "b", "b.md"] }));
    assert.equal(body.nodes[0]?.id, "b");
    assert.equal(body.nodes.filter((node) => node.depth === 0).length, 1);
  });

  it("prefers an id match over a path match", async () => {
    const body = await ok(
      [
        { path: "a.md", cache: fm({ id: "shared" }) },
        { path: "b.md", cache: fm({ id: "a.md" }) }
      ],
      request({ start: ["a.md"] })
    );
    assert.deepEqual(body.nodes.map((node) => node.id), ["a.md"]);
  });

  it("omitted direction matches explicit out", async () => {
    const explicit = await ok(files, request({ start: ["a"], direction: "out" }));
    const withoutDirection = request({ start: ["a"] });
    delete withoutDirection.direction;
    const omitted = await ok(files, withoutDirection);
    const missing = await ok(files, request({ start: ["a"], direction: null }));
    assert.deepEqual(omitted, explicit);
    assert.deepEqual(missing, explicit);
    const inbound = await ok(files, request({ start: ["a"], direction: "in" }));
    assert.notDeepEqual(
      omitted.nodes.map((node) => node.id),
      inbound.nodes.map((node) => node.id)
    );
  });
});

describe("graph traverse defaults", () => {
  it("minimal body {scope, edges} returns 200 and nodes keyed by path", async () => {
    const files: FakeFile[] = [
      {
        path: "Notes/a.md",
        cache: fm({ id: "alpha", depends_on: ["Notes/b.md", "beta", "alias-c"] })
      },
      { path: "Notes/b.md", cache: fm({ id: "beta" }) },
      { path: "Folder/c.md", cache: fm({ id: "gamma" }) }
    ];
    const recorded: unknown[] = [];
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    registerGraphTraverseRoute({
      addRoute() {
        return {
          post(next) {
            handler = next;
          }
        };
      }
    }, deps(files, {}, {
      index: createIndex(files, (linkpath) => (linkpath === "alias-c" ? "Folder/c.md" : null))
    }));
    const response = {
      status(status: number) {
        recorded.push(status);
        return this;
      },
      json(payload: unknown) {
        recorded.push(payload);
      }
    };
    await handler?.({ body: { scope: "Notes/", edges: [{ source: "depends_on" }] } }, response);
    assert.equal(recorded[0], 200);
    const body = recorded[1] as GraphTraverseResponse;
    assert.deepEqual(body.nodes.map((node) => [node.id, node.path, node.depth]), [
      ["Folder/c.md", "Folder/c.md", 0],
      ["Notes/a.md", "Notes/a.md", 0],
      ["Notes/b.md", "Notes/b.md", 0]
    ]);
    assert.deepEqual(body.edges, [
      { from: "Notes/a.md", to: "Folder/c.md", source: "depends_on" },
      { from: "Notes/a.md", to: "Notes/b.md", source: "depends_on" }
    ]);
    assert.deepEqual(body.unresolved, [
      { from: "Notes/a.md", value: "beta", source: "depends_on" }
    ]);
    assert.deepEqual(body.conflicts, []);
    assert.deepEqual(body.cycles, []);
  });
});

describe("graph traverse export, cycles, and filters", () => {
  it("exports every in-scope node and outside endpoints when start is omitted", async () => {
    const body = await ok(
      [
        { path: "In/a.md", cache: fm({ id: "a", depends_on: "b" }) },
        { path: "In/c.md", cache: fm({ id: "c" }) },
        { path: "Out/b.md", cache: fm({ id: "b", depends_on: "hidden" }) },
        { path: "Out/hidden.md", cache: fm({ id: "hidden" }) }
      ],
      request({ scope: "In/", start: null })
    );
    assert.deepEqual(body.nodes.map((node) => [node.id, node.depth]), [
      ["a", 0],
      ["b", 0],
      ["c", 0]
    ]);
    assert.deepEqual(body.edges, [{ from: "a", to: "b", source: "depends_on" }]);
    assert.equal(body.nodes.some((node) => node.id === "hidden"), false);
  });

  it("reports each strongly connected component once and does not loop", async () => {
    const body = await ok(
      [
        { path: "a.md", cache: fm({ id: "a", depends_on: ["b", "a"] }) },
        { path: "b.md", cache: fm({ id: "b", depends_on: "a" }) },
        { path: "c.md", cache: fm({ id: "c", depends_on: "d" }) },
        { path: "d.md", cache: fm({ id: "d", depends_on: "c" }) },
        { path: "e.md", cache: fm({ id: "e", depends_on: "e" }) }
      ],
      request()
    );
    assert.deepEqual(body.cycles, [
      ["a", "b"],
      ["c", "d"]
    ]);
    assert.equal(body.truncated, false);
  });

  it("does not treat a one-way edge as a cycle when walking both ways", async () => {
    const body = await ok(
      [
        { path: "a.md", cache: fm({ id: "a", depends_on: "b" }) },
        { path: "b.md", cache: fm({ id: "b" }) }
      ],
      request({ start: ["a"], direction: "both" })
    );
    assert.deepEqual(body.cycles, []);
    assert.deepEqual(body.nodes.map((node) => node.id), ["a", "b"]);
  });

  it("keeps section on a filtered body edge and passes embeds through", async () => {
    const files: FakeFile[] = [
      {
        path: "a.md",
        cache: fm({ id: "a" }, {
          headings: [
            heading("Definition of Done", 1, 10),
            heading("Notes", 2, 40)
          ],
          links: [link("b", 20)],
          embeds: [embed("c", 50)]
        })
      },
      { path: "b.md", cache: fm({ id: "b" }) },
      { path: "c.md", cache: fm({ id: "c" }) }
    ];
    const filtered = await ok(files, request({
      edges: [{ source: BODY_SOURCE, sections: ["Definition of Done"] }],
      start: ["a"]
    }));
    assert.deepEqual(filtered.edges, [{
      from: "a",
      to: "b",
      source: BODY_SOURCE,
      section: "Definition of Done"
    }]);

    const withEmbed = await ok(files, request({
      edges: [{ source: BODY_SOURCE, embeds: true }],
      start: ["a"]
    }));
    assert.deepEqual(withEmbed.edges.map((edge) => edge.to), ["b", "c"]);
    assert.equal(withEmbed.edges.find((edge) => edge.to === "c")?.section, "Notes");

    const above = await ok(
      [
        {
          path: "a.md",
          cache: fm({ id: "a" }, {
            headings: [heading("Later", 1, 30)],
            links: [link("b", 5), link("b", 40)]
          })
        },
        { path: "b.md", cache: fm({ id: "b" }) }
      ],
      request({ edges: [{ source: BODY_SOURCE }], start: ["a"] })
    );
    assert.deepEqual(above.edges, [
      { from: "a", to: "b", source: BODY_SOURCE, section: null },
      { from: "a", to: "b", source: BODY_SOURCE, section: "Later" }
    ]);
  });

  it("returns conflicts and only the unresolved rows of visited nodes", async () => {
    const files: FakeFile[] = [
      { path: "a.md", cache: fm({ id: "dup", depends_on: "missing" }) },
      { path: "b.md", cache: fm({ id: "dup" }) },
      { path: "c.md", cache: fm({ id: "c" }) }
    ];
    const visited = await ok(files, request({ start: ["a.md"] }));
    assert.deepEqual(visited.unresolved, [{ from: "dup", value: "missing", source: "depends_on" }]);
    assert.deepEqual(visited.conflicts, [{ id: "dup", paths: ["a.md", "b.md"] }]);

    const other = await ok(files, request({ start: ["c"] }));
    assert.deepEqual(other.unresolved, []);
    assert.deepEqual(other.conflicts, []);
  });

  it("keeps every note when an id field collides with another note's path", async () => {
    const files: FakeFile[] = [
      { path: "a.md", cache: fm({ id: "b.md", depends_on: "c", status: "from-a" }) },
      { path: "b.md", cache: fm({ status: "from-b" }) },
      { path: "c.md", cache: fm({ id: "c" }) }
    ];
    const notes: Record<string, NoteView> = {
      "a.md": { frontmatter: { status: "from-a" } },
      "b.md": { frontmatter: { status: "from-b" } },
      "c.md": { frontmatter: { id: "c" } }
    };
    const exported = await ok(files, request({ include: ["status", "$path"] }), notes);
    assert.deepEqual(exported.conflicts, []);
    assert.deepEqual(exported.nodes.map((node) => [node.id, node.path, node.depth, node.fields.status]), [
      ["b.md", "a.md", 0, "from-a"],
      ["b.md", "b.md", 0, "from-b"],
      ["c", "c.md", 0, null]
    ]);
    assert.deepEqual(exported.edges, [{ from: "b.md", to: "c", source: "depends_on" }]);

    const started = await ok(files, request({ start: ["b.md"], include: ["$path"] }), notes);
    assert.deepEqual(started.nodes.map((node) => [node.id, node.path, node.depth]), [
      ["b.md", "a.md", 0],
      ["b.md", "b.md", 0],
      ["c", "c.md", 1]
    ]);
    assert.deepEqual(started.nodes.map((node) => node.fields.$path), ["a.md", "b.md", "c.md"]);
    assert.deepEqual(started.edges, [{ from: "b.md", to: "c", source: "depends_on" }]);
  });

  it("does not mutate the cached index", async () => {
    const index = createIndex([
      { path: "a.md", cache: fm({ id: "a", depends_on: "b" }) },
      { path: "b.md", cache: fm({ id: "b" }) }
    ]);
    const before = index.get({ scope: "", idField: "id", edges: [{ source: "depends_on" }] });
    const edge = before.edges[0];
    await executeGraphTraverse({
      index,
      indexReady: () => true
    }, request({ start: ["a"] }));
    const after = index.get({ scope: "", idField: "id", edges: [{ source: "depends_on" }] });
    assert.equal(after, before);
    assert.equal(after.edges[0], edge);
  });
});

describe("graph traverse include", () => {
  it("projects frontmatter, path, mtime, and body without the frontmatter fence", async () => {
    const text = "---\nid: a\nstatus: ready\n---\n# Done\nSee [[b]]\n";
    const body = await ok(
      [{ path: "Notes/a.md", cache: fm({ id: "a", status: "ready" }) }],
      request({
        start: ["a"],
        include: ["status", "owner", "$body", "$path", "$mtime", "status", "link", "tags"]
      }),
      {
        "Notes/a.md": {
          frontmatter: {
            status: "ready",
            link: { path: "Notes/b.md", type: "file" },
            tags: {
              array: () => ["one"],
              get value(): never {
                throw new Error("DataArray .value must not be followed");
              }
            }
          },
          text,
          mtime: 1_700_000_000_000
        }
      }
    );
    assert.deepEqual(body.nodes[0]?.fields, {
      status: "ready",
      owner: null,
      $body: "# Done\nSee [[b]]\n",
      $path: "Notes/a.md",
      $mtime: 1_700_000_000_000,
      link: "Notes/b.md",
      tags: ["one"]
    });
  });

  it("uses the metadata offset when one is present and leaves fields empty otherwise", async () => {
    const sliced = await ok(
      [{ path: "a.md", cache: fm({ id: "a" }) }],
      request({ start: ["a"], include: ["$body"] }),
      { "a.md": { text: "FRONTBody", bodyStart: 5 } }
    );
    assert.equal(sliced.nodes[0]?.fields.$body, "Body");

    const empty = await ok(
      [{ path: "a.md", cache: fm({ id: "a" }) }],
      request({ start: ["a"] })
    );
    assert.deepEqual(empty.nodes[0]?.fields, {});
  });

  it("returns null fields when a note cannot be read and flags a clipped body", async () => {
    const failed = await ok(
      [{ path: "a.md", cache: fm({ id: "a" }) }],
      request({ start: ["a"], include: ["$body", "$path"] }),
      {},
      {
        readNote: () => {
          throw new Error("unreadable");
        }
      }
    );
    assert.deepEqual(failed.nodes[0]?.fields, { $body: null, $path: "a.md" });
    assert.equal(failed.truncated, false);

    const clipped = await ok(
      [{ path: "a.md", cache: fm({ id: "a" }) }],
      request({ start: ["a"], include: ["$body"] }),
      { "a.md": { text: "x".repeat(DEFAULT_MAX_STRING_LENGTH + 5) } }
    );
    assert.equal(clipped.nodes[0]?.fields.$body, "x".repeat(DEFAULT_MAX_STRING_LENGTH));
    assert.equal(clipped.truncated, true);
  });

  it("strips an empty or CRLF frontmatter fence and leaves other text unchanged", () => {
    assert.equal(bodyExcludingFrontmatter("---\n---\nBody"), "Body");
    assert.equal(bodyExcludingFrontmatter("---\r\nid: a\r\n---\r\n# Hi\r\n"), "# Hi\r\n");
    assert.equal(bodyExcludingFrontmatter("# Hi"), "# Hi");
    assert.equal(bodyExcludingFrontmatter("---\nno close"), "---\nno close");
    assert.equal(bodyExcludingFrontmatter("abcdef", 0), "abcdef");
    assert.equal(bodyExcludingFrontmatter("abcdef", 99), "");
  });
});

describe("graph traverse errors and caps", () => {
  const files: FakeFile[] = [
    { path: "a.md", cache: fm({ id: "a", depends_on: "b" }) },
    { path: "b.md", cache: fm({ id: "b", depends_on: "c" }) },
    { path: "c.md", cache: fm({ id: "c" }) }
  ];

  it("rejects an unknown direction, empty edges, missing starts, and an empty scope", async () => {
    const direction = await executeGraphTraverse(deps(files), request({ direction: "sideways" }));
    assert.deepEqual(direction, { ok: false, status: 400, message: "direction must be one of: out, in, both" });

    const edges = await executeGraphTraverse(deps(files), request({ edges: [] }));
    assert.equal(edges.ok, false);
    if (!edges.ok) assert.equal(edges.message, "edges must be a non-empty list");

    const missing = await executeGraphTraverse(deps(files), request({ start: ["missing-a", "missing-a", "missing-b"] }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.message, "Unknown start: missing-a, missing-b");

    const scope = await executeGraphTraverse(deps(files), request({ scope: "Empty/" }));
    assert.equal(scope.ok, false);
    if (!scope.ok) assert.equal(scope.message, "scope has no notes");
  });

  it("rejects malformed request fields", async () => {
    const cases: Array<Record<string, unknown> | null> = [
      null,
      request({ scope: 1 }),
      request({ id_field: "  " }),
      request({ id_field: "" }),
      request({ id_field: 1 }),
      request({ max_depth: -1 }),
      request({ max_depth: 1.5 }),
      request({ include: "status" }),
      request({ start: [] }),
      request({ start: "a" }),
      request({ edges: [{ source: "  " }] }),
      request({ edges: [{ source: "depends_on", sections: [1] }] }),
      request({ edges: [{ source: "depends_on", embeds: "yes" }] }),
      request({ limit_nodes: 0 }),
      request({ limit_edges: 1.2 }),
      request({ timeout_ms: 0 })
    ];
    for (const body of cases) {
      const outcome = await executeGraphTraverse(deps(files), body);
      assert.equal(outcome.ok, false, JSON.stringify(body));
      if (!outcome.ok) assert.equal(outcome.status, 400);
    }
  });

  it("sets truncated when the node, edge, or time cap is hit", async () => {
    const nodes = await ok(files, request({ start: ["c", "a", "b"], limit_nodes: 1, direction: "in" }));
    assert.deepEqual(nodes.nodes.map((node) => node.id), ["a"]);
    assert.equal(nodes.truncated, true);

    const neighborCap = await ok(files, request({ start: ["a"], limit_nodes: 2 }));
    assert.deepEqual(neighborCap.nodes.map((node) => node.id), ["a", "b"]);
    assert.equal(neighborCap.truncated, true);

    let midWalkCalls = 0;
    const midWalk = await ok(files, request({ start: ["a"], timeout_ms: 10 }), {}, {
      now: () => {
        midWalkCalls += 1;
        return midWalkCalls >= 3 ? 10_000 : 0;
      }
    });
    assert.deepEqual(midWalk.nodes.map((node) => node.id), ["a"]);
    assert.equal(midWalk.truncated, true);

    const edges = await ok(
      [
        { path: "a.md", cache: fm({ id: "a", depends_on: "b" }) },
        { path: "b.md", cache: fm({ id: "b", depends_on: "a" }) }
      ],
      request({ limit_edges: 1 })
    );
    assert.equal(edges.edges.length, 1);
    assert.deepEqual(edges.cycles, [["a", "b"]]);
    assert.equal(edges.truncated, true);

    let calls = 0;
    const timed = await ok(files, request({ start: ["a"], timeout_ms: 10 }), {}, {
      now: () => {
        calls += 1;
        return calls > 1 ? 10_000 : 0;
      }
    });
    assert.deepEqual(timed.nodes.map((node) => node.id), ["a"]);
    assert.equal(timed.truncated, true);

    const whole = await ok(
      [
        { path: "In/b.md", cache: fm({ id: "b" }) },
        { path: "In/a.md", cache: fm({ id: "a", depends_on: "out" }) },
        { path: "Out/out.md", cache: fm({ id: "out" }) }
      ],
      request({ scope: "In", limit_nodes: 2 })
    );
    assert.deepEqual(whole.nodes.map((node) => node.id), ["a", "b"]);
    assert.equal(whole.edges.length, 0);
    assert.equal(whole.truncated, true);
  });

  it("stops projecting later notes after the deadline", async () => {
    let time = 0;
    const body = await ok(
      [
        { path: "a.md", cache: fm({ id: "a" }) },
        { path: "b.md", cache: fm({ id: "b" }) }
      ],
      request({ include: ["$body"], timeout_ms: 1000 }),
      {},
      {
        now: () => time,
        readNote: (path) => {
          time = 5_000;
          return { text: path };
        }
      }
    );
    assert.equal(body.truncated, true);
    assert.equal(body.nodes.find((node) => node.id === "a")?.fields.$body, "a.md");
    assert.equal(body.nodes.find((node) => node.id === "b")?.fields.$body, null);
  });

  it("clamps an oversize limit without marking a small graph truncated", async () => {
    const body = await ok(
      [{ path: "a.md", cache: fm({ id: "a" }) }],
      request({ start: ["a"], limit_nodes: MAX_LIMIT_NODES + 50, timeout_ms: 999_999 })
    );
    assert.equal(body.truncated, false);
    assert.equal(body.nodes.length, 1);
  });

  it("turns an index validation error into 400 and rethrows other failures", async () => {
    const invalid = await executeGraphTraverse({
      index: {
        get() {
          throw new Error("Graph scope must be a string");
        },
        invalidate() {},
        dispose() {}
      },
      indexReady: () => true
    }, request());
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.message, "Graph scope must be a string");

    await assert.rejects(() => executeGraphTraverse({
      index: {
        get() {
          throw new Error("disposed");
        },
        invalidate() {},
        dispose() {}
      },
      indexReady: () => false
    }, request({ start: ["a"] })), /disposed/);
  });
});

describe("graph traverse route", () => {
  it("sends the JSON body and a 400 through the REST helpers", async () => {
    const sent: unknown[] = [];
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    registerGraphTraverseRoute({
      addRoute(path) {
        assert.equal(path, GRAPH_TRAVERSE_PATH);
        return {
          post(next) {
            handler = next;
          }
        };
      },
      sendSuccess(_res, body) {
        sent.push(body);
      },
      sendError(_res, status, message) {
        sent.push({ status, message });
      }
    }, deps([{ path: "a.md", cache: fm({ id: "a" }) }], {}, { indexReady: () => false }));

    assert.equal(typeof handler, "function");
    await handler?.({ body: request({ start: ["a"] }) }, {});
    const success = sent[0] as GraphTraverseResponse;
    assert.equal(success.index_ready, false);
    assert.equal(success.nodes[0]?.id, "a");

    await handler?.({ json: request({ direction: "nope" }) }, {});
    assert.deepEqual(sent[1], { status: 400, message: "direction must be one of: out, in, both" });
  });

  it("uses the response object when the REST helpers are absent and ignores a missing post", async () => {
    const recorded: unknown[] = [];
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    registerGraphTraverseRoute({
      addRoute() {
        return {
          post(next) {
            handler = next;
          }
        };
      }
    }, deps([{ path: "a.md", cache: fm({ id: "a" }) }]));
    const response = {
      status(status: number) {
        recorded.push(status);
        return this;
      },
      json(body: unknown) {
        recorded.push(body);
      }
    };
    await handler?.({ body: request({ start: ["a"] }) }, response);
    assert.equal(recorded[0], 200);
    await handler?.({}, response);
    assert.equal(recorded[2], 400);

    const before = recorded.length;
    registerGraphTraverseRoute({
      addRoute() {
        return {};
      }
    }, deps([{ path: "a.md", cache: fm({ id: "a" }) }]));
    assert.equal(recorded.length, before);
  });

  it("reports a handler failure as 500", async () => {
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const errors: Array<{ status: number; message: string }> = [];
    registerGraphTraverseRoute({
      addRoute() {
        return {
          post(next) {
            handler = next;
          }
        };
      },
      sendError(_res, status, message) {
        errors.push({ status, message });
      }
    }, {
      index: {
        get() {
          throw new Error("boom");
        },
        invalidate() {},
        dispose() {}
      },
      indexReady: () => true
    });
    await handler?.({ body: request({ start: ["a"] }) }, {});
    assert.deepEqual(errors, [{ status: 500, message: "boom" }]);
  });
});

describe("metadata cache readiness and vault notes", () => {
  it("treats a settled cache as ready and pending work as not ready", () => {
    assert.equal(graphIndexReady(null), false);
    assert.equal(graphIndexReady(undefined), false);
    assert.equal(graphIndexReady({ initialized: false }), false);
    assert.equal(graphIndexReady({ initialized: true, inProgressTaskCount: 2 }), false);
    assert.equal(graphIndexReady({ queue: ["one"] }), false);
    assert.equal(graphIndexReady({ queue: { length: 1 } }), false);
    assert.equal(graphIndexReady({ initialized: true, inProgressTaskCount: 0 }), true);
    assert.equal(graphIndexReady({}), true);
    assert.equal(graphIndexReady({ queue: { length: "nope" } }), true);
  });

  it("reads body, mtime, and frontmatter from a markdown file", async () => {
    const file = {
      path: "Notes/a.md",
      extension: "md",
      stat: { mtime: 42 }
    };
    const note = await readVaultNote({
      vault: {
        getAbstractFileByPath(path) {
          return path === file.path ? file : { path, extension: "canvas" };
        },
        cachedRead: async () => "---\nid: a\n---\nBody"
      },
      metadataCache: {
        getFileCache() {
          return {
            frontmatter: { id: "a" },
            frontmatterPosition: { end: { offset: 12 } }
          };
        }
      }
    }, "Notes/a.md");
    assert.deepEqual(note, {
      frontmatter: { id: "a" },
      text: "---\nid: a\n---\nBody",
      bodyStart: 12,
      mtime: 42
    });
    assert.equal(await readVaultNote({
      vault: {
        getAbstractFileByPath: () => ({ extension: "canvas" })
      },
      metadataCache: {}
    }, "Notes/a.canvas"), null);
  });

  it("opens the app index, reports live readiness, and disposes it", () => {
    const listeners: Record<string, () => void> = {};
    const refs: string[] = [];
    let initialized: unknown = true;
    const app = {
      vault: {
        getMarkdownFiles: () => [{ path: "A.md" }],
        getAbstractFileByPath: () => null,
        on(name: string, callback: () => void) {
          listeners[`vault:${name}`] = callback;
          return { id: `vault:${name}` };
        },
        offref(ref: { id: string }) {
          refs.push(ref.id);
        }
      },
      metadataCache: {
        get initialized() {
          return initialized;
        },
        getCache(): CachedMetadata | null {
          return { frontmatter: { id: "a" } };
        },
        getFirstLinkpathDest() {
          return null;
        },
        on(name: string, callback: () => void) {
          listeners[`metadata:${name}`] = callback;
          return { id: `metadata:${name}` };
        },
        offref(ref: { id: string }) {
          refs.push(ref.id);
        }
      }
    };
    const opened = openGraphTraverse(app as unknown as App);
    assert.equal(opened.deps.indexReady(), true);
    initialized = false;
    assert.equal(opened.deps.indexReady(), false);
    const graph = opened.deps.index.get({ scope: "", idField: "id", edges: [{ source: "depends_on" }] });
    assert.equal(graph.nodes[0]?.id, "a");
    opened.dispose();
    opened.dispose();
    assert.equal(refs.length, 4);
    assert.throws(() => opened.deps.index.get({
      scope: "",
      idField: "id",
      edges: [{ source: "depends_on" }]
    }), /disposed/);
  });
});
