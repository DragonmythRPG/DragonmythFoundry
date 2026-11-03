import test from "node:test";
import assert from "node:assert/strict";
import { spendActionResources, recoverResourcePools, removeConsumedEquipmentPools } from "../scripts/resource-pools.mjs";

const pools = [
  { id: "charges", name: "Charges", scope: "owner", ownerInstanceId: "wand-one", current: 8, maximumValue: 8, recovery: [] },
  { id: "charges", name: "Charges", scope: "owner", ownerInstanceId: "wand-two", current: 8, maximumValue: 8, recovery: [] },
  { id: "focus", name: "Focus", scope: "character", ownerInstanceId: null, current: 2, maximumValue: 8,
    recovery: [{ trigger: "short-rest", amount: { type: "dice", formula: "1d4+1d6+2" } }] },
];

test("consumed equipment loses only its instance-owned pools", () => {
  const previous = [{ instanceId: "wand-one", type: "consumable" }, { instanceId: "wand-two", type: "equipment" }];
  const next = removeConsumedEquipmentPools(pools, previous, [previous[1]]);
  assert.deepEqual(next.map(({ ownerInstanceId }) => ownerInstanceId), ["wand-two", null]);
  assert.equal(pools.length, 3);
});

test("resource actions roll compound costs once and isolate equipment instances", async () => {
  const formulas = [];
  const next = await spendActionResources(pools, { costs: [
    { poolScope: "owner", poolId: "charges", quantity: "1d4+1d6+2" },
    { poolScope: "owner", poolId: "charges", quantity: 1 },
  ] }, "wand-one", async (formula) => { formulas.push(formula); return 5; });
  assert.deepEqual(formulas, ["1d4+1d6+2"]);
  assert.equal(next[0].current, 2);
  assert.equal(next[1].current, 8);
  assert.equal(pools[0].current, 8);
});

test("unavailable or depleted costs do not change any pools", async () => {
  await assert.rejects(spendActionResources(pools, { costs: [
    { poolScope: "character", poolId: "focus", quantity: 3 },
  ] }, "wand-one", async () => 1), /Not enough Focus/);
  await assert.rejects(spendActionResources(pools, { costs: [
    { poolScope: "owner", poolId: "missing", quantity: 1 },
  ] }, "wand-one", async () => 1), /unavailable resource/);
  assert.deepEqual(pools.map(({ current }) => current), [8, 8, 2]);
});

test("rest recovery rolls number-or-dice amounts and clamps to derived maximums", async () => {
  const next = await recoverResourcePools(pools, "short-rest", async (formula) => {
    assert.equal(formula, "1d4+1d6+2");
    return 9;
  });
  assert.equal(next[2].current, 8);
  assert.equal(pools[2].current, 2);
  assert.equal((await recoverResourcePools(pools, "long-rest", async () => 1))[2].current, 2);
});
