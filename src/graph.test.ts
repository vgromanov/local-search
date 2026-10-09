import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { App, CachedMetadata, EmbedCache, HeadingCache, LinkCache, Pos } from "obsidian";

import {
  BODY_SOURCE,
  createLinkGraphIndex,
  createLinkGraphIndexFromApp,
  type GraphEdgeSource,
  type GraphQuery,
  type LinkGraphHost
} from "./graph.ts";

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

interface FakeFile {
  path: string;
  cache: CachedMetadata | null;
}

function createHost(
  initial: FakeFile[],
  resolve?: (linkpath: string, sourcePath: string) => string | null
) {
  let files = initial;
  const listeners = new Set<() => void>();
  let lists = 0;
  let resolves: Array<{ linkpath: string; sourcePath: string }> = [];
  const host: LinkGraphHost = {
    listMarkdownPaths() {
      lists += 1;
      return files.map((file) => file.path);
    },
    getCache(path) {
      return files.find((file) => file.path === path)?.cache ?? null;
    },
    resolveLink(linkpath, sourcePath) {
      resolves.push({ linkpath, sourcePath });
      return resolve?.(linkpath, sourcePath) ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return {
    host,
    emit() {
      for (const listener of [...listeners]) listener();
    },
    setFiles(next: FakeFile[]) {
      files = next;
    },
    lists: () => lists,
    resolved: () => resolves,
    listeners: () => listeners.size
  };
}

function query(edges: GraphEdgeSource[], extra: Partial<GraphQuery> = {}): GraphQuery {
  return { scope: "", idField: "id", edges, ...extra };
}

function fm(frontmatter: Record<string, unknown>, extra: Partial<CachedMetadata> = {}): CachedMetadata {
  return { frontmatter, ...extra };
}

describe("frontmatter edges", () => {
  it("resolves a list of bare ids and keeps an isolate in scope", () => {
    const fake = createHost([
      { path: "b.md", cache: fm({ id: "d-b" }) },
      { path: "a.md", cache: fm({ id: "d-a", depends_on: ["d-b", "d-b"] }) },
      { path: "c.md", cache: fm({ id: "d-c" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }]));
    assert.deepEqual(graph.edges, [{ from: "d-a", to: "d-b", source: "depends_on" }]);
    assert.deepEqual(graph.nodes.map((node) => node.id), ["d-a", "d-b", "d-c"]);
    assert.deepEqual(graph.unresolved, []);
    assert.deepEqual(graph.conflicts, []);
  });

  it("resolves wikilinks, vault paths, link objects, and DataArray values", () => {
    const calls: string[] = [];
    const fake = createHost(
      [
        { path: "Notes/wiki.md", cache: fm({ id: "d-wiki" }) },
        { path: "Notes/exact.md", cache: fm({ id: "d-exact" }) },
        { path: "Notes/linked.md", cache: fm({ id: "d-linked" }) },
        { path: "Notes/array.md", cache: fm({ id: "d-array" }) },
        {
          path: "Notes/source.md",
          cache: fm({
            id: "d-source",
            depends_on: [
              "[[d-wiki#Heading|Alias]]",
              "Notes/exact.md",
              { path: "Notes/linked.md", type: "file" },
              {
                array: () => ["d-array"],
                get value(): never {
                  throw new Error("DataArray .value must not be followed");
                }
              }
            ]
          })
        }
      ],
      (linkpath) => {
        calls.push(linkpath);
        return null;
      }
    );
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }], { scope: "Notes" }));
    assert.deepEqual(
      graph.edges.map((edge) => edge.to),
      ["d-array", "d-exact", "d-linked", "d-wiki"]
    );
    assert.equal(calls.includes("d-wiki"), false);
    assert.equal(calls.includes("d-array"), false);
    assert.equal(calls.includes("Notes/exact.md"), true);
    assert.equal(calls.includes("Notes/linked.md"), true);
  });

  it("prefers the id index over link resolution and then an exact path", () => {
    const seen: Array<{ linkpath: string; sourcePath: string }> = [];
    const fake = createHost(
      [
        { path: "Keep/id.md", cache: fm({ id: "shared" }) },
        { path: "Keep/other.md", cache: fm({ id: "other" }) },
        { path: "Keep/plain.md", cache: fm({}) },
        {
          path: "Keep/source.md",
          cache: fm({
            id: "source",
            depends_on: ["shared", "Other Name#Heading", "Keep/plain", "missing"]
          })
        }
      ],
      (linkpath, sourcePath) => {
        seen.push({ linkpath, sourcePath });
        if (linkpath === "Other Name") return "Keep/other.md";
        if (linkpath === "Elsewhere/nope.md") return "Elsewhere/nope.md";
        return null;
      }
    );
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }], { scope: "Keep/" }));
    assert.deepEqual(
      graph.edges.map((edge) => [edge.to, edge.source]),
      [
        ["Keep/plain.md", "depends_on"],
        ["other", "depends_on"],
        ["shared", "depends_on"]
      ]
    );
    assert.deepEqual(seen, [
      { linkpath: "Other Name", sourcePath: "Keep/source.md" },
      { linkpath: "Keep/plain", sourcePath: "Keep/source.md" },
      { linkpath: "missing", sourcePath: "Keep/source.md" }
    ]);
    assert.deepEqual(graph.unresolved, [{ from: "source", value: "missing", source: "depends_on" }]);
    assert.equal(graph.nodes.some((node) => node.path === "Keep/plain.md" && node.id === "Keep/plain.md"), true);
  });

  it("appends .md when the link path omits the extension", () => {
    const fake = createHost([
      { path: "Dir/target.md", cache: fm({ id: "target-id" }) },
      { path: "Dir/source.md", cache: fm({ id: "source", depends_on: "Dir/target" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }]));
    assert.equal(graph.edges[0]?.to, "target-id");
  });

  it("keeps unresolved wikilinks and ignores empty tokens", () => {
    const fake = createHost([
      {
        path: "a.md",
        cache: fm({
          id: "a",
          depends_on: ["[[nope|Alias]]", "  ", null, 7, { path: "not-a-link" }]
        })
      },
      { path: "n.md", cache: fm({ id: "7" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }]));
    assert.deepEqual(graph.edges, [{ from: "a", to: "7", source: "depends_on" }]);
    assert.deepEqual(graph.unresolved, [{ from: "a", value: "[[nope|Alias]]", source: "depends_on" }]);
  });

  it("does not expand notes outside scope and flags them", () => {
    const fake = createHost([
      { path: "In/a.md", cache: fm({ id: "d-a", depends_on: ["d-b"] }) },
      { path: "Out/b.md", cache: fm({ id: "d-b", depends_on: ["d-c"] }) },
      { path: "Out/c.md", cache: fm({ id: "d-c" }) },
      { path: "Other/d.md", cache: fm({ id: "d-d" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }], { scope: "In" }));
    assert.deepEqual(graph.edges, [{ from: "d-a", to: "d-b", source: "depends_on" }]);
    assert.deepEqual(graph.nodes, [
      { id: "d-a", path: "In/a.md", inScope: true },
      { id: "d-b", path: "Out/b.md", inScope: false }
    ]);
  });

  it("does not treat a trailing-slash scope as a partial filename prefix", () => {
    const fake = createHost([
      { path: "Infra.md", cache: fm({ id: "file" }) },
      { path: "Infra/note.md", cache: fm({ id: "child", depends_on: "file" }) },
      { path: "Infra Planning/note.md", cache: fm({ id: "plan" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }], { scope: "Infra/" }));
    assert.deepEqual(graph.nodes.map((node) => node.path), ["Infra.md", "Infra/note.md"]);
    assert.equal(graph.nodes.find((node) => node.path === "Infra.md")?.inScope, false);
    assert.equal(graph.edges[0]?.from, "child");
  });
});

describe("duplicate ids", () => {
  it("reports every path and lets the first path own the id", () => {
    const fake = createHost([
      { path: "b.md", cache: fm({ id: "d-x", depends_on: "d-z" }) },
      { path: "a.md", cache: fm({ id: "d-x", depends_on: "d-y" }) },
      { path: "z.md", cache: fm({ id: "d-z" }) },
      { path: "y.md", cache: fm({ id: "d-y" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }]));
    assert.deepEqual(graph.conflicts, [{ id: "d-x", paths: ["a.md", "b.md"] }]);
    assert.deepEqual(graph.edges, [
      { from: "b.md", to: "d-z", source: "depends_on" },
      { from: "d-x", to: "d-y", source: "depends_on" }
    ]);
    assert.equal(graph.nodes.find((node) => node.path === "a.md")?.id, "d-x");
    assert.equal(graph.nodes.find((node) => node.path === "b.md")?.id, "b.md");
  });

  it("resolves a shared id to the winning path even when both notes are outside scope", () => {
    const fake = createHost([
      { path: "In/a.md", cache: fm({ id: "in", depends_on: "dup" }) },
      { path: "Out/b.md", cache: fm({ id: "dup" }) },
      { path: "Out/a.md", cache: fm({ id: "dup", depends_on: "in" }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }], { scope: "In/" }));
    assert.deepEqual(graph.conflicts, [{ id: "dup", paths: ["Out/a.md", "Out/b.md"] }]);
    assert.deepEqual(graph.edges, [{ from: "in", to: "dup", source: "depends_on" }]);
    assert.equal(graph.nodes.find((node) => node.id === "dup")?.path, "Out/a.md");
  });
});

describe("$body sections", () => {
  it("attributes links to the nearest heading and uses null before the first heading", () => {
    const fake = createHost([
      { path: "t.md", cache: fm({ id: "target" }) },
      {
        path: "s.md",
        cache: fm(
          { id: "source" },
          {
            headings: [heading("Alpha", 2, 100), heading("Beta", 2, 200)],
            links: [link("target", 10), link("target#Heading", 150), link("target", 250)]
          }
        )
      }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: BODY_SOURCE }]));
    assert.deepEqual(graph.edges, [
      { from: "source", to: "target", source: BODY_SOURCE, section: null },
      { from: "source", to: "target", source: BODY_SOURCE, section: "Alpha" },
      { from: "source", to: "target", source: BODY_SOURCE, section: "Beta" }
    ]);
  });

  it("filters by ancestor headings and drops links in other sections", () => {
    const fake = createHost([
      { path: "keep.md", cache: fm({ id: "keep" }) },
      { path: "drop.md", cache: fm({ id: "drop" }) },
      {
        path: "s.md",
        cache: fm(
          { id: "source" },
          {
            headings: [heading("Definition of Done", 2, 50), heading("Checks", 3, 80), heading("Notes", 2, 200)],
            links: [
              link("missing-before", 10),
              link("keep", 100),
              link("drop", 250),
              link("missing-section", 260)
            ]
          }
        )
      }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{
      source: BODY_SOURCE,
      sections: ["Definition of Done", "Definition"]
    }]));
    assert.deepEqual(graph.edges, [
      { from: "source", to: "keep", source: BODY_SOURCE, section: "Checks" }
    ]);
    assert.deepEqual(graph.unresolved, []);
  });

  it("reports an unresolved body link with its section", () => {
    const fake = createHost([
      {
        path: "s.md",
        cache: fm(
          { id: "source" },
          {
            headings: [heading("Alpha", 2, 20)],
            links: [link("missing", 40), link("missing", 40)]
          }
        )
      }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: BODY_SOURCE }]));
    assert.deepEqual(graph.unresolved, [
      { from: "source", value: "missing", source: BODY_SOURCE, section: "Alpha" }
    ]);
  });

  it("includes embeds only when requested and ignores frontmatter links", () => {
    const fake = createHost([
      { path: "body.md", cache: fm({ id: "body" }) },
      { path: "embed.md", cache: fm({ id: "embed-id" }) },
      { path: "fm.md", cache: fm({ id: "fm-id" }) },
      {
        path: "s.md",
        cache: {
          frontmatter: { id: "source", depends_on: "fm-id" },
          frontmatterPosition: at(0, 40),
          sections: [{ type: "yaml", position: at(0, 40) }, { type: "paragraph", position: at(41, 80) }],
          headings: [heading("Body", 2, 41)],
          frontmatterLinks: [{ key: "depends_on", link: "fm-id", original: "[[fm-id]]", position: at(10) }],
          links: [link("fm-id", 10), link("body", 50)],
          embeds: [embed("embed-id", 60)]
        }
      }
    ]);
    const index = createLinkGraphIndex(fake.host);
    const linksOnly = index.get(query([{ source: BODY_SOURCE }]));
    assert.deepEqual(linksOnly.edges, [
      { from: "source", to: "body", source: BODY_SOURCE, section: "Body" }
    ]);
    const withEmbeds = index.get(query([{ source: BODY_SOURCE, embeds: true }]));
    assert.deepEqual(withEmbeds.edges, [
      { from: "source", to: "body", source: BODY_SOURCE, section: "Body" },
      { from: "source", to: "embed-id", source: BODY_SOURCE, section: "Body" }
    ]);
  });

  it("uses a link on a heading line as that heading", () => {
    const fake = createHost([
      { path: "t.md", cache: fm({ id: "target" }) },
      {
        path: "s.md",
        cache: fm({ id: "source" }, {
          headings: [heading("  Alpha  ", 2, 30), heading("", 2, 10)],
          links: [link("target", 30)]
        })
      }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: BODY_SOURCE }]));
    assert.equal(graph.edges[0]?.section, "Alpha");
  });
});

describe("cache invalidation", () => {
  it("reuses a cached graph until rename, delete, changed, or resolved", () => {
    const fake = createHost([
      { path: "A.md", cache: fm({ id: "a", depends_on: "b" }) },
      { path: "B.md", cache: fm({ id: "b" }) }
    ]);
    const index = createLinkGraphIndex(fake.host);
    const first = index.get(query([{ source: "depends_on" }]));
    fake.setFiles([
      { path: "A.md", cache: fm({ id: "a", depends_on: "c" }) },
      { path: "C.md", cache: fm({ id: "c" }) }
    ]);
    assert.equal(index.get(query([{ source: "depends_on" }])), first);
    assert.equal(fake.lists(), 1);

    fake.emit();
    const renamed = index.get(query([{ source: "depends_on" }]));
    assert.notEqual(renamed, first);
    assert.deepEqual(renamed.edges, [{ from: "a", to: "c", source: "depends_on" }]);
    assert.equal(renamed.nodes.some((node) => node.path === "B.md"), false);
    assert.equal(fake.lists(), 2);

    index.invalidate();
    index.get(query([{ source: "depends_on" }]));
    assert.equal(fake.lists(), 3);
  });

  it("treats equivalent edge specs as one cache entry", () => {
    const fake = createHost([{ path: "a.md", cache: fm({ id: "a" }) }]);
    const index = createLinkGraphIndex(fake.host);
    const left = index.get(query([
      { source: "depends_on" },
      { source: BODY_SOURCE, sections: ["B", "A"], embeds: false }
    ]));
    const right = index.get(query([
      { source: ` ${BODY_SOURCE} `, sections: ["A", "B", ""] },
      { source: " depends_on " }
    ], { scope: "  ", idField: " id " }));
    assert.equal(left, right);
    assert.equal(fake.lists(), 1);
  });

  it("subscribes through the app adapter and drops the cache on rename", () => {
    let files = [{ path: "A.md" }];
    const listeners: Record<string, () => void> = {};
    const refs: string[] = [];
    const app = {
      vault: {
        getMarkdownFiles: () => files.map((file) => ({ path: file.path })),
        on(name: "rename" | "delete", callback: () => void) {
          listeners[`vault:${name}`] = callback;
          return { id: `vault:${name}` };
        },
        offref(ref: { id: string }) {
          refs.push(ref.id);
        }
      },
      metadataCache: {
        getCache(path: string): CachedMetadata | null {
          if (path === "A.md") return { frontmatter: { id: "a", depends_on: "missing" } };
          if (path === "B.md") return { frontmatter: { id: "b" } };
          return null;
        },
        getFirstLinkpathDest() {
          return null;
        },
        on(name: "changed" | "resolved", callback: () => void) {
          listeners[`metadata:${name}`] = callback;
          return { id: `metadata:${name}` };
        },
        offref(ref: { id: string }) {
          refs.push(ref.id);
        }
      }
    };
    const index = createLinkGraphIndexFromApp(app as unknown as App);
    assert.deepEqual(Object.keys(listeners).sort(), [
      "metadata:changed",
      "metadata:resolved",
      "vault:delete",
      "vault:rename"
    ]);
    const before = index.get(query([{ source: "depends_on" }]));
    assert.equal(before.nodes[0]?.id, "a");
    files = [{ path: "B.md" }];
    listeners["vault:rename"]();
    const after = index.get(query([{ source: "depends_on" }]));
    assert.equal(after.nodes[0]?.path, "B.md");
    index.dispose();
    index.dispose();
    assert.deepEqual(refs.sort(), [
      "metadata:changed",
      "metadata:resolved",
      "vault:delete",
      "vault:rename"
    ]);
    assert.throws(() => index.get(query([{ source: "depends_on" }])), /disposed/);
  });
});

describe("id scalars and unresolved ordering", () => {
  it("accepts a numeric id, an embed wikilink, and falls back when the id is empty", () => {
    const fake = createHost([
      { path: "n.md", cache: fm({ id: 12 }) },
      { path: "bad.md", cache: fm({ id: { foo: true } }) },
      { path: "empty.md", cache: fm({ id: "[[]]" }) },
      { path: "s.md", cache: fm({ id: "s", depends_on: ["![[12]]", "[[]]"] }) }
    ]);
    const graph = createLinkGraphIndex(fake.host).get(query([{ source: "depends_on" }]));
    assert.equal(graph.nodes.find((node) => node.path === "n.md")?.id, "12");
    assert.equal(graph.nodes.find((node) => node.path === "bad.md")?.id, "bad.md");
    assert.equal(graph.nodes.find((node) => node.path === "empty.md")?.id, "empty.md");
    assert.deepEqual(graph.edges, [{ from: "s", to: "12", source: "depends_on" }]);
    assert.deepEqual(graph.unresolved, [{ from: "s", value: "[[]]", source: "depends_on" }]);
  });

  it("sorts unresolved body links by section and ignores a linkpath outside the vault", () => {
    const fake = createHost(
      [
        {
          path: "s.md",
          cache: fm({ id: "s", see_also: "z-missing" }, {
            headings: [heading("Alpha", 2, 100)],
            links: [link("missing", 10), link("missing", 150), link("", 160)]
          })
        },
        { path: "t.md", cache: fm({ id: "t", see_also: "a-missing" }) }
      ],
      (linkpath) => (linkpath === "ghost" ? "outside.md" : null)
    );
    const withGhost = createHost(
      [{ path: "s.md", cache: fm({ id: "s", depends_on: "ghost" }) }],
      (linkpath) => (linkpath === "ghost" ? "outside.md" : null)
    );
    const graph = createLinkGraphIndex(fake.host).get(query([
      { source: "see_also" },
      { source: BODY_SOURCE }
    ]));
    assert.deepEqual(graph.unresolved, [
      { from: "s", value: "missing", source: BODY_SOURCE, section: null },
      { from: "s", value: "missing", source: BODY_SOURCE, section: "Alpha" },
      { from: "s", value: "z-missing", source: "see_also" },
      { from: "t", value: "a-missing", source: "see_also" }
    ]);
    const ghost = createLinkGraphIndex(withGhost.host).get(query([{ source: "depends_on" }]));
    assert.deepEqual(ghost.unresolved, [{ from: "s", value: "ghost", source: "depends_on" }]);
  });
});

describe("query validation", () => {
  it("rejects an empty edge list, a blank id field, and bad section filters", () => {
    const fake = createHost([]);
    const index = createLinkGraphIndex(fake.host);
    assert.throws(() => index.get(query([])), /non-empty list/);
    assert.throws(() => index.get(query([{ source: "depends_on" }], { idField: "  " })), /idField/);
    assert.throws(() => index.get(query([{ source: "  " }])), /source/);
    assert.throws(
      () => index.get(query([{ source: BODY_SOURCE, sections: ["ok", 1 as unknown as string] }])),
      /sections/
    );
    assert.throws(() => index.get({ scope: 1 as unknown as string, idField: "id", edges: [{ source: "id" }] }), /scope/);
    assert.equal(fake.lists(), 0);
    index.dispose();
  });
});
