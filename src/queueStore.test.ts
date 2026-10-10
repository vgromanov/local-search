import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCoalescedSaver, parseStoredQueue } from "./queueStore.ts";

const item = (path: string) => ({
  path,
  enqueuedAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  attempts: 0,
  lastError: ""
});

describe("parseStoredQueue", () => {
  it("reads a valid queue", () => {
    const parsed = parseStoredQueue(JSON.stringify({ version: 1, items: [item("a.md"), item("b.md")] }));
    assert.equal(parsed.corrupt, false);
    assert.deepEqual(parsed.items.map((entry) => entry.path), ["a.md", "b.md"]);
  });

  it("treats an empty file (crash mid-write) as an empty queue", () => {
    assert.deepEqual(parseStoredQueue(""), { items: [], corrupt: true });
    assert.deepEqual(parseStoredQueue("  \n"), { items: [], corrupt: true });
  });

  it("treats truncated or non-queue JSON as an empty queue", () => {
    assert.deepEqual(parseStoredQueue('{"version":1,"items":[{"pa'), { items: [], corrupt: true });
    assert.deepEqual(parseStoredQueue("null"), { items: [], corrupt: true });
    assert.deepEqual(parseStoredQueue('{"items":{}}'), { items: [], corrupt: true });
  });

  it("drops entries without a path", () => {
    const parsed = parseStoredQueue(JSON.stringify({ version: 1, items: [item("a.md"), null, { attempts: 1 }] }));
    assert.deepEqual(parsed.items.map((entry) => entry.path), ["a.md"]);
  });
});

describe("createCoalescedSaver", () => {
  it("collapses a burst of saves into one follow-up write", async () => {
    let writes = 0;
    let state = 0;
    const written: number[] = [];
    const releases: Array<() => void> = [];
    const save = createCoalescedSaver(async () => {
      writes++;
      const snapshot = state;
      await new Promise<void>((resolve) => releases.push(resolve));
      written.push(snapshot);
    });

    const pending: Promise<void>[] = [];
    for (let i = 1; i <= 4000; i++) {
      state = i;
      pending.push(save());
    }
    assert.equal(writes, 1);

    releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 2);
    releases.shift()!();
    await Promise.all(pending);

    assert.equal(writes, 2);
    assert.deepEqual(written, [1, 4000]);
  });

  it("settles every caller only after a write that includes its state", async () => {
    let state = "";
    const written: string[] = [];
    const save = createCoalescedSaver(async () => {
      const snapshot = state;
      await Promise.resolve();
      written.push(snapshot);
    });

    state = "a";
    const first = save();
    state = "b";
    const second = save();
    await second;
    assert.equal(written.at(-1), "b");
    await first;
  });

  it("rejects callers on write failure and recovers on the next save", async () => {
    let fail = true;
    let writes = 0;
    const save = createCoalescedSaver(async () => {
      writes++;
      if (fail) throw new Error("disk full");
    });

    await assert.rejects(save(), /disk full/);
    fail = false;
    await save();
    assert.equal(writes, 2);
  });
});
