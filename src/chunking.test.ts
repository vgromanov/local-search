import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkText } from "./chunking.ts";

const file = {
  path: "fixture.md",
  basename: "fixture",
  stat: { mtime: 0, size: 0 }
} as Parameters<typeof chunkText>[0];
const metadata = { bodyHash: "fixture-hash", folder: "" };

function split(body: string, size = 1200, overlap = 180) {
  return chunkText(file, body, metadata, size, overlap);
}

/** Locate each emitted passage and require coverage of all meaningful source characters. */
function assertCoverage(body: string, size: number, overlap: number) {
  const source = body.replace(/\r\n/g, "\n").trim();
  const covered = new Set<number>();
  let previousStart = -1;
  const chunks = split(body, size, overlap);
  assert.ok(chunks.length <= source.length, "chunking must make forward progress");
  for (const chunk of chunks) {
    // Trimming can give consecutive overlapping chunks the same visible start.
    const start = source.indexOf(chunk.text, Math.max(0, previousStart));
    assert.ok(start >= Math.max(0, previousStart), "chunks must follow original source order");
    assert.ok(chunk.text.length <= size, "chunks must respect the size limit");
    for (let i = start; i < start + chunk.text.length; i++) covered.add(i);
    previousStart = start;
  }
  for (let i = 0; i < source.length; i++) {
    if (/\S/u.test(source[i])) assert.ok(covered.has(i), `uncovered source character at ${i}`);
  }
}

describe("chunkText source coverage", () => {
  it("retains text after an early paragraph boundary", () => {
    const body = "A".repeat(700) + "\n\nGAP_MARKER" + "B".repeat(1500);
    const chunks = split(body);
    assert.ok(chunks.some((chunk) => chunk.text.includes("GAP_MARKER")));
    assert.equal(chunks[1].text, body.slice(520, 1720));
  });

  it("covers repeated paragraph boundaries with zero, normal, and oversized overlap", () => {
    // Unique characters make each emitted passage's original position unambiguous.
    const paragraphs = [700, 630, 1100, 800, 370].map((length, paragraph) =>
      Array.from({ length }, (_, i) => String.fromCharCode(0xE000 + paragraph * 1200 + i)).join(""));
    const body = paragraphs.join("\n\n");
    for (const overlap of [0, 180, 700, 1200, 1500]) {
      assertCoverage(body, 1200, overlap);
    }
  });

  it("preserves coverage when a paragraph boundary is just past half the window", () => {
    for (const boundary of [601, 700, 1019, 1020, 1199]) {
      const body = Array.from({ length: 2400 }, (_, i) => String.fromCharCode(0xE000 + i)).join("");
      assertCoverage(body.slice(0, boundary) + "\n\n" + body.slice(boundary), 1200, 180);
    }
  });

  it("keeps fixed-window overlap for text without paragraph breaks", () => {
    const body = "0123456789".repeat(300);
    assert.deepEqual(split(body).map((chunk) => chunk.text), [
      body.slice(0, 1200), body.slice(1020, 2220), body.slice(2040)
    ]);
  });

  it("normalizes line endings and ignores empty bodies", () => {
    assert.deepEqual(split(" \r\n\r\n "), []);
    assert.equal(split("  first\r\n\r\nsecond  ")[0].text, "first\n\nsecond");
  });
});
