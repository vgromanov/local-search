import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { chunkingConfigHash, splitMarkdownBody } from "./chunking.ts";

describe("markdown chunk boundaries", () => {
  it("keeps overlap after shortening a chunk at a paragraph break", () => {
    const body = "a".repeat(700) + "\n\n" + "b".repeat(1500);
    const chunks = splitMarkdownBody(body, 1200, 180);
    assert.equal(chunks[0], "a".repeat(700));
    assert.equal(chunks[1], "a".repeat(180) + "\n\n" + "b".repeat(1018));
    assert.equal(chunks[2], "b".repeat(662));
  });

  it("covers every non-whitespace character across paragraph layouts and overlaps", () => {
    // Unique characters make omissions observable even in repeated paragraphs.
    const characters = Array.from({ length: 2400 }, (_, i) => String.fromCharCode(0x4e00 + i));
    for (const paragraphLength of [47, 151, 207, 299, 401]) {
      const body = characters.map((c, i) => i % paragraphLength === 0 ? "\n\n" + c : c).join("");
      for (const overlap of [0, 45, 180, 300, 450]) {
        const chunks = splitMarkdownBody(body, 300, overlap);
        const covered = new Set(chunks.join(""));
        assert.ok(characters.every(c => covered.has(c)), `Missing text: paragraph=${paragraphLength}, overlap=${overlap}`);
        assert.ok(chunks.every(c => c.length <= 300));
        assert.ok(chunks.length <= body.length, "Must make forward progress");
      }
    }
  });

  it("handles empty, short, CRLF and unbroken bodies", () => {
    assert.deepEqual(splitMarkdownBody(" \r\n ", 10, 2), []);
    assert.deepEqual(splitMarkdownBody(" a\r\nb ", 10, 2), ["a\nb"]);
    assert.deepEqual(splitMarkdownBody("abcdefghijklmnop", 10, 2), ["abcdefghij", "ijklmnop"]);
  });

  it("rejects invalid settings instead of looping or skipping text", () => {
    for (const [size, overlap] of [[0, 0], [NaN, 0], [10, -1], [10, Infinity]]) {
      assert.throws(() => splitMarkdownBody("body", size, overlap));
    }
  });
});

describe("chunking configuration invalidation", () => {
  it("invalidates v1 chunks with unchanged size and overlap", () => {
    const oldHash = createHash("sha256").update(JSON.stringify({
      chunkSize: 1200, chunkOverlap: 180, indexedBody: "markdown-body-v1"
    })).digest("hex");
    assert.notEqual(chunkingConfigHash(1200, 180), oldHash);
    assert.notEqual(chunkingConfigHash(1200, 180), chunkingConfigHash(1200, 0));
    assert.notEqual(chunkingConfigHash(1200, 180), chunkingConfigHash(600, 180));
  });
});
