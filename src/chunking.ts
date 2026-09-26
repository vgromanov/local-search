import type { TFile } from "obsidian";
import type { VaultChunk, VectorRecord } from "./types";

// Included in the indexing hash so unchanged notes are rechunked on reindex.
export const CHUNKING_VERSION = "markdown-body-v2";

export function chunkText(file: TFile, body: string, metadata: Pick<VectorRecord, "bodyHash" | "folder">, chunkSize: number, overlap: number): VaultChunk[] {
  const clean = body.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks: VaultChunk[] = [];
  let start = 0;
  let position = 0;

  while (start < clean.length) {
    const end = Math.min(clean.length, start + chunkSize);
    let sliceEnd = end;
    if (end < clean.length) {
      const paragraphBreak = clean.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize * 0.5) {
        sliceEnd = paragraphBreak;
      }
    }
    const chunk = clean.slice(start, sliceEnd).trim();
    if (chunk) {
      chunks.push({
        id: `${file.path}#${metadata.bodyHash.slice(0, 12)}#${position}`,
        path: file.path,
        folder: metadata.folder,
        basename: file.basename,
        mtime: file.stat.mtime,
        size: file.stat.size,
        position,
        text: chunk
      });
      position++;
    }
    // Advance from the actual boundary, not the full-window step: paragraph
    // shortening must never leave a gap. Always progress even with oversized overlap.
    start = sliceEnd >= clean.length ? clean.length : Math.max(sliceEnd - overlap, start + 1);
  }

  return chunks;
}
