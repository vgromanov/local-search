export type QueueItem = {
  path: string;
  enqueuedAt: string;
  updatedAt: string;
  attempts: number;
  lastError: string;
};

export type StoredQueue = {
  version: 1;
  items: QueueItem[];
};

/**
 * Parse `index-queue.json`. A crash mid-write can leave the file empty or
 * truncated; treat that as an empty queue instead of failing plugin load.
 */
export function parseStoredQueue(raw: string): { items: QueueItem[]; corrupt: boolean } {
  if (!raw.trim()) return { items: [], corrupt: true };
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { items: [], corrupt: true };
  }
  const items = (stored as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { items: [], corrupt: true };
  return {
    items: items.filter((item): item is QueueItem =>
      !!item && typeof item === "object" && typeof (item as QueueItem).path === "string"
    ),
    corrupt: false
  };
}

/**
 * Coalesce saves: at most one write in flight, and any number of calls made
 * meanwhile collapse into a single follow-up write of the latest snapshot.
 * Every returned promise settles after a write that includes the caller's state.
 *
 * Without this, Obsidian's startup `create` event for every vault file made
 * each enqueue serialize the whole queue — O(n²) pending strings, renderer OOM.
 */
export function createCoalescedSaver(write: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let dirty = false;

  return () => {
    dirty = true;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          while (dirty) {
            dirty = false;
            await write();
          }
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}
