import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeValue, type SerializeResult } from "./serialize.ts";

function link(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { path, type: "file", ...extra };
}

function warningCodes(result: SerializeResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("serializeValue primitives", () => {
  it("passes JSON primitives through and normalizes undefined", () => {
    assert.deepEqual(serializeValue(null), { value: null, warnings: [], truncated: false });
    assert.deepEqual(serializeValue(undefined), { value: null, warnings: [], truncated: false });
    assert.equal(serializeValue(true).value, true);
    assert.equal(serializeValue(0).value, 0);
    assert.equal(serializeValue("note").value, "note");
  });

  it("omits undefined object fields and nulls undefined array slots", () => {
    const result = serializeValue({ keep: 1, skip: undefined, items: [undefined, "a"] });
    assert.deepEqual(result.value, { keep: 1, items: [null, "a"] });
    assert.deepEqual(result.warnings, []);
  });

  it("nulls non-finite numbers", () => {
    const result = serializeValue({ bad: Number.NaN, big: Number.POSITIVE_INFINITY });
    assert.deepEqual(result.value, { bad: null, big: null });
    assert.deepEqual(warningCodes(result), ["non-finite-number", "non-finite-number"]);
    assert.equal(result.truncated, false);
  });
});

describe("serializeValue links", () => {
  it("emits the file path and ignores subpath", () => {
    const result = serializeValue(
      link("Projects/a.md", { type: "header", display: "Title", subpath: "#Title" })
    );
    assert.equal(result.value, "Projects/a.md");
    assert.deepEqual(result.warnings, []);
  });

  it("emits path and display only when linkDisplay is requested", () => {
    const withDisplay = serializeValue(link("Projects/a.md", { display: "Alpha" }), {
      linkDisplay: true
    });
    assert.deepEqual(withDisplay.value, { path: "Projects/a.md", display: "Alpha" });

    const withoutDisplay = serializeValue(link("Projects/a.md"), { linkDisplay: true });
    assert.deepEqual(withoutDisplay.value, { path: "Projects/a.md" });
    assert.equal("display" in (withoutDisplay.value as object), false);
  });

  it("recognizes a Link class instance", () => {
    class Link {
      path = "Notes/class.md";
      display = "Class";
    }
    assert.equal(serializeValue(new Link()).value, "Notes/class.md");
    assert.deepEqual(serializeValue(new Link(), { linkDisplay: true }).value, {
      path: "Notes/class.md",
      display: "Class"
    });
  });

  it("serializes nested lists of links", () => {
    const result = serializeValue([
      [link("a.md"), link("b.md", { type: "block", display: "B" })],
      [link("c.md", { type: "header" })]
    ]);
    assert.deepEqual(result.value, [
      ["a.md", "b.md"],
      ["c.md"]
    ]);
  });
});

describe("serializeValue temporals", () => {
  it("converts Luxon DateTime and Duration to ISO-8601", () => {
    const result = serializeValue({
      when: { isLuxonDateTime: true, toISO: () => "2024-05-06T07:08:09.000Z" },
      span: { isLuxonDuration: true, toISO: () => "PT1H30M" }
    });
    assert.deepEqual(result.value, {
      when: "2024-05-06T07:08:09.000Z",
      span: "PT1H30M"
    });
    assert.deepEqual(result.warnings, []);
  });

  it("accepts DateTime and Duration constructor names", () => {
    class DateTime {
      toISO(): string {
        return "2020-01-02T03:04:05.000Z";
      }
    }
    class Duration {
      toISO(): string {
        return "P2D";
      }
    }
    assert.deepEqual(serializeValue({ at: new DateTime(), dur: new Duration() }).value, {
      at: "2020-01-02T03:04:05.000Z",
      dur: "P2D"
    });
  });

  it("converts JavaScript Date and nulls invalid temporals without throwing", () => {
    const result = serializeValue({
      date: new Date("2020-01-02T03:04:05.000Z"),
      invalidDate: new Date("not-a-date"),
      invalidDateTime: { isLuxonDateTime: true, toISO: () => null },
      throwing: {
        isLuxonDuration: true,
        toISO() {
          throw new Error("boom");
        }
      }
    });
    assert.equal(result.value && (result.value as { date: string }).date, "2020-01-02T03:04:05.000Z");
    assert.equal((result.value as { invalidDate: null }).invalidDate, null);
    assert.equal((result.value as { invalidDateTime: null }).invalidDateTime, null);
    assert.equal((result.value as { throwing: null }).throwing, null);
    assert.ok(warningCodes(result).includes("invalid-temporal"));
    assert.equal(result.truncated, false);
  });
});

describe("serializeValue DataArray and pages", () => {
  it("materializes DataArray values through array() and never reads value or to", () => {
    const seen: string[] = [];
    const rows = [link("Notes/a.md"), link("Notes/b.md", { display: "B" })];
    const dataArray = new Proxy(
      {},
      {
        get(_target, prop) {
          const name = String(prop);
          seen.push(name);
          if (prop === "array") return () => rows;
          if (prop === "value" || prop === "to") throw new Error(`followed ${name}`);
          return undefined;
        }
      }
    );

    const result = serializeValue(dataArray);
    assert.deepEqual(result.value, ["Notes/a.md", "Notes/b.md"]);
    assert.equal(seen.includes("value"), false);
    assert.equal(seen.includes("to"), false);
  });

  it("nulls a DataArray whose array() throws", () => {
    const dataArray = {
      array() {
        throw new Error("nope");
      }
    };
    const result = serializeValue(dataArray);
    assert.equal(result.value, null);
    assert.deepEqual(warningCodes(result), ["unsupported"]);
  });

  it("keeps a plain field named value", () => {
    assert.deepEqual(serializeValue({ value: "ok" }).value, { value: "ok" });
  });

  it("drops canonical page keys and keeps frontmatter spelling", () => {
    const due = { isLuxonDateTime: true, toISO: () => "2024-05-06T00:00:00.000Z" };
    const page = {
      file: {
        path: "Projects/a.md",
        name: "a",
        frontmatter: {
          Status: "ready",
          "Due Date": due,
          "Hello, World!": 1
        }
      },
      status: "ready",
      "due-date": due,
      "hello-world": 1,
      priority: 2
    };

    const result = serializeValue(page);
    assert.deepEqual(result.value, {
      file: {
        path: "Projects/a.md",
        name: "a",
        frontmatter: {
          Status: "ready",
          "Due Date": "2024-05-06T00:00:00.000Z",
          "Hello, World!": 1
        }
      },
      Status: "ready",
      "Due Date": "2024-05-06T00:00:00.000Z",
      "Hello, World!": 1,
      priority: 2
    });
    assert.deepEqual(Object.keys(result.value as object), [
      "file",
      "Status",
      "Due Date",
      "Hello, World!",
      "priority"
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it("drops a duplicate canonical key and warns when the values differ", () => {
    const result = serializeValue({
      file: { path: "a.md", frontmatter: { Status: "from-frontmatter" } },
      Status: "from-original",
      status: "from-canonical"
    });
    assert.deepEqual(result.value, {
      file: { path: "a.md", frontmatter: { Status: "from-frontmatter" } },
      Status: "from-original"
    });
    assert.deepEqual(warningCodes(result), ["dropped-duplicate-key"]);
  });

  it("drops a canonical duplicate even when frontmatter does not list the field", () => {
    const shared = "ready";
    const same = serializeValue({
      file: { path: "a.md", frontmatter: {} },
      "Due Date": shared,
      "due-date": shared
    });
    assert.deepEqual(same.value, {
      file: { path: "a.md", frontmatter: {} },
      "Due Date": "ready"
    });
    assert.deepEqual(same.warnings, []);

    const different = serializeValue({
      file: { path: "a.md" },
      "Due Date": "original",
      "due-date": "canonical"
    });
    assert.equal((different.value as { "Due Date": string })["Due Date"], "original");
    assert.equal("due-date" in (different.value as object), false);
    assert.deepEqual(warningCodes(different), ["dropped-duplicate-key"]);
  });

  it("nulls a DataArray whose array() does not return an array", () => {
    const result = serializeValue({ array: () => "nope" });
    assert.equal(result.value, null);
    assert.deepEqual(warningCodes(result), ["unsupported"]);
  });

  it("does not rename file metadata when frontmatter has a File key", () => {
    const result = serializeValue({
      file: { path: "a.md", frontmatter: { File: "not-metadata", Status: "ready" } },
      status: "ready"
    });
    const value = result.value as { file: { path: string }; Status: string };
    assert.equal(value.file.path, "a.md");
    assert.equal(value.Status, "ready");
    assert.equal("File" in (result.value as object), false);
    assert.equal("status" in (result.value as object), false);
  });

  it("leaves metadataCache objects unchanged when they are not pages", () => {
    const result = serializeValue({ Status: "ready", status: "other", tags: ["a"] });
    assert.deepEqual(result.value, { Status: "ready", status: "other", tags: ["a"] });
  });
});

describe("serializeValue grouped rows and guards", () => {
  it("serializes GROUP BY row structures", () => {
    const result = serializeValue({
      headers: ["File", "status"],
      values: [
        {
          key: "ready",
          rows: [
            [link("a.md"), "ready"],
            [link("b.md"), "ready"]
          ]
        },
        { key: "draft", rows: [[link("c.md"), "draft"]] }
      ]
    });
    assert.deepEqual(result.value, {
      headers: ["File", "status"],
      values: [
        {
          key: "ready",
          rows: [
            ["a.md", "ready"],
            ["b.md", "ready"]
          ]
        },
        { key: "draft", rows: [["c.md", "draft"]] }
      ]
    });
    assert.equal(JSON.parse(JSON.stringify(result.value)).values[0].key, "ready");
  });

  it("stops a self-referential page and a self-referential DataArray proxy", () => {
    const page: Record<string, unknown> = {
      file: { path: "a.md", frontmatter: {} }
    };
    page.child = page;
    const pageResult = serializeValue(page);
    assert.equal((pageResult.value as { child: null }).child, null);
    assert.ok(warningCodes(pageResult).includes("cycle"));
    assert.equal(pageResult.truncated, false);

    const seen: string[] = [];
    const proxy: object = new Proxy(
      {},
      {
        get(_target, prop) {
          const name = String(prop);
          seen.push(name);
          if (prop === "value" || prop === "to") throw new Error(`followed ${name}`);
          if (prop === "array") return () => [proxy];
          return undefined;
        }
      }
    );
    const proxyResult = serializeValue(proxy);
    assert.deepEqual(proxyResult.value, [null]);
    assert.ok(warningCodes(proxyResult).includes("cycle"));
    assert.equal(seen.includes("value"), false);
    assert.equal(seen.includes("to"), false);
  });

  it("flags depth and string truncation", () => {
    let nested: unknown = { name: "leaf" };
    for (let i = 0; i < 6; i += 1) nested = { child: nested };
    const deep = serializeValue(nested, { maxDepth: 2 });
    assert.equal(deep.truncated, true);
    assert.ok(warningCodes(deep).includes("truncated-depth"));

    const long = serializeValue({ text: "x".repeat(20) }, { maxStringLength: 5 });
    assert.deepEqual(long.value, { text: "xxxxx" });
    assert.equal(long.truncated, true);
    assert.deepEqual(warningCodes(long), ["truncated-string"]);
  });

  it("nulls functions, widgets, and unknown class instances without calling them", () => {
    class Widget {
      render(): string {
        throw new Error("called");
      }
    }
    class Box {
      x = 1;
    }
    const fn = () => {
      throw new Error("called");
    };
    const result = serializeValue({ fn, widget: new Widget(), box: new Box(), n: 1n });
    assert.deepEqual(result.value, { fn: null, widget: null, box: null, n: null });
    assert.ok(warningCodes(result).every((code) => code === "unsupported"));
    assert.equal(result.warnings.length, 4);
  });

  it("does not treat a plain object with toISO as a DateTime", () => {
    const result = serializeValue({
      toISO() {
        return "not-a-datetime";
      }
    });
    assert.deepEqual(result.value, { toISO: null });
    assert.deepEqual(warningCodes(result), ["unsupported"]);
  });
});
