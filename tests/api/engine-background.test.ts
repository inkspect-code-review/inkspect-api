import test from "node:test";
import assert from "node:assert/strict";
import { scheduleBackgroundWork } from "../../src/engine-background";

test("background work requires the active, non-draining generation and a free slot", async () => {
  let calls = 0;
  const work = async () => { calls++; };
  const track = async (run: () => Promise<void>) => { await run(); };
  const state = { generation: "new", activeGeneration: "new", draining: false, active: 0 };
  for (const denied of [{ ...state, draining: true }, { ...state, activeGeneration: "old" }, { ...state, active: 2 }]) {
    assert.equal(scheduleBackgroundWork(denied, work, track), false);
  }
  assert.equal(scheduleBackgroundWork(state, undefined, track), false);
  assert.equal(calls, 0);
  assert.equal(scheduleBackgroundWork(state, work, track), true);
  assert.equal(calls, 1);
});

test("the active counter stays held through drain until background work settles", async () => {
  let release!: () => void, active = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const work = () => pending;
  const tracked: Promise<void>[] = [];
  const track = (run: () => Promise<void>) => {
    active++;
    const result = run().finally(() => { active--; });
    tracked.push(result); return result;
  };
  const state = { generation: "new", activeGeneration: "new", draining: false, active: 0 };
  assert.equal(scheduleBackgroundWork(state, work, track), true);
  assert.equal(active, 1);
  assert.equal(scheduleBackgroundWork({ ...state, draining: true, active }, work, track), false);
  assert.equal(active, 1);
  release(); await Promise.all(tracked);
  assert.equal(active, 0);
});
