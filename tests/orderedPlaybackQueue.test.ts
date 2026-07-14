import { it } from "node:test";
import assert from "node:assert/strict";
import { OrderedPlaybackQueue } from "../src/lib/orderedPlaybackQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("prepares audio concurrently but consumes it in sentence order", async () => {
  const played: string[] = [];
  const queue = new OrderedPlaybackQueue<string>(async (value) => { played.push(value); });
  const first = deferred<string>();
  const second = deferred<string>();

  queue.enqueue(first.promise);
  queue.enqueue(second.promise);
  second.resolve("second");
  await Promise.resolve();
  assert.deepEqual(played, []);
  first.resolve("first");
  await queue.whenIdle();
  assert.deepEqual(played, ["first", "second"]);
});

it("drops prepared audio from a reset conversation", async () => {
  const played: string[] = [];
  const queue = new OrderedPlaybackQueue<string>(async (value) => { played.push(value); });
  const old = deferred<string>();
  queue.enqueue(old.promise);
  queue.reset();
  old.resolve("stale");
  queue.enqueue(Promise.resolve("current"));
  await queue.whenIdle();
  assert.deepEqual(played, ["current"]);
});

it("continues in order after one preparation rejects and reports that sentence once", async () => {
  const played: string[] = [];
  const errors: unknown[] = [];
  const queue = new OrderedPlaybackQueue<string>(
    async (value) => { played.push(value); },
    (error) => { errors.push(error); },
  );
  const failed = Promise.reject(new Error("first sentence failed"));
  const second = deferred<string>();

  queue.enqueue(failed);
  queue.enqueue(second.promise);
  second.resolve("second sentence");
  await queue.whenIdle();

  assert.deepEqual(played, ["second sentence"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /first sentence failed/);
});
