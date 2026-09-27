import { createHash } from "crypto";

// Bump this whenever chunk boundaries or indexed-body semantics change.
const INDEXED_BODY_VERSION = "markdown-body-v2";

export function chunkingConfigHash(chunkSize: number, chunkOverlap: number): string {
  return createHash("sha256").update(JSON.stringify({
    chunkSize,
    chunkOverlap,
    indexedBody: INDEXED_BODY_VERSION
  })).digest("hex");
}

export function splitMarkdownBody(body: string, chunkSize: number, overlap: number): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(overlap) || overlap < 0) {
    throw new Error("Chunk size must be a positive integer and overlap a non-negative integer.");
  }
  const clean = body.replace(/\r\n/g, "\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + chunkSize);
    let sliceEnd = end;
    if (end < clean.length) {
      const paragraphBreak = clean.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize * 0.5) sliceEnd = paragraphBreak;
    }
    const chunk = clean.slice(start, sliceEnd).trim();
    if (chunk) chunks.push(chunk);
    // Advance relative to the actual end, including when a paragraph shortened
    // the chunk. A nominal-size step can jump past text that was never indexed.
    start = sliceEnd >= clean.length ? clean.length : Math.max(sliceEnd - overlap, start + 1);
  }
  return chunks;
}
