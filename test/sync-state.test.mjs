import test from "node:test";
import assert from "node:assert/strict";
import { resolveSyncChanges } from "../scripts/sync-state.mjs";

test("resource gameplay state participates in bidirectional synchronization", () => {
  const baseline = { resourcePools: [{ id: "charges", scope: "owner", ownerInstanceId: "wand", current: 4 }] };
  const actor = { resourcePools: [{ ...baseline.resourcePools[0], current: 2 }] };
  const result = resolveSyncChanges(baseline, baseline, baseline, actor);
  assert.deepEqual(result.acceptedLocalChanges, ["resourcePools"]);
  assert.deepEqual(result.changes.resourcePools, actor.resourcePools);
  const remote = { resourcePools: [{ ...baseline.resourcePools[0], current: 3 }] };
  const conflict = resolveSyncChanges(baseline, remote, baseline, actor);
  assert.deepEqual(conflict.conflicts, ["resourcePools"]);
  assert.deepEqual(conflict.changes, {});
});

test("same-field conflicts keep the website value while accepting disjoint Foundry edits", () => {
  const baseline = {
    name: "Mira",
    hpCurrent: 8,
    biography: { backstory: "A wanderer.", notes: "A secret." },
    systemData: { inspiration: false, items: [{ name: "Dagger" }] },
  };
  const website = {
    ...baseline,
    hpCurrent: 10,
    biography: { ...baseline.biography, notes: "Updated secret." },
    systemData: { ...baseline.systemData, inspiration: true },
  };
  const actor = {
    ...baseline,
    hpCurrent: 6,
    biography: { ...baseline.biography, backstory: "A veteran." },
    systemData: { ...baseline.systemData, items: [{ name: "Longsword" }] },
  };

  const result = resolveSyncChanges(baseline, website, baseline, actor);

  assert.deepEqual(result.conflicts, ["hpCurrent"]);
  assert.deepEqual(result.acceptedLocalChanges, [
    "biography.backstory",
    "systemData.items",
  ]);
  assert.deepEqual(result.changes, {
    biography: { backstory: "A veteran." },
    systemData: { items: [{ name: "Longsword" }] },
  });
});

test("website-only and Foundry-only changes are both identified", () => {
  const baseline = { name: "Mira", abilities: { str: 15, dex: 14 } };
  const website = { name: "Mira Vale", abilities: { str: 15, dex: 14 } };
  const actor = { name: "Mira", abilities: { str: 16, dex: 14 } };

  const result = resolveSyncChanges(baseline, website, baseline, actor);

  assert.deepEqual(result.websiteChanges, ["name"]);
  assert.deepEqual(result.acceptedLocalChanges, ["abilities.str"]);
  assert.deepEqual(result.changes, { abilities: { str: 16 } });
  assert.deepEqual(result.conflicts, []);
});
