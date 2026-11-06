import test from "node:test";
import assert from "node:assert/strict";
import {
  classFeatureSyncKey,
  classProgressionSyncKey,
  getSyncFlag,
  managedEntryDocuments,
  MODULE_ID,
  normalizeSyncActorData,
} from "../scripts/sync-flags.mjs";

test("website flags are normalized into the active module namespace", () => {
  const actor = {
    flags: {
      core: { sourceId: "Compendium.example" },
      dragonmyth: { biography: { pronouns: "they/them" }, shared: "website" },
      [MODULE_ID]: { websiteCharacterId: "42", shared: "module" },
    },
    items: [{ flags: { dragonmyth: { websiteSourceKey: "items:0" } } }],
    effects: [{ flags: { dragonmyth: { websiteSourceKey: "effects:0" } } }],
  };

  const normalized = normalizeSyncActorData(actor);

  assert.deepEqual(normalized.flags, {
    core: { sourceId: "Compendium.example" },
    [MODULE_ID]: {
      biography: { pronouns: "they/them" },
      shared: "module",
      websiteCharacterId: "42",
    },
  });
  assert.deepEqual(normalized.items[0].flags, {
    [MODULE_ID]: { websiteSourceKey: "items:0" },
  });
  assert.deepEqual(normalized.effects[0].flags, {
    [MODULE_ID]: { websiteSourceKey: "effects:0" },
  });
  assert.equal(actor.flags.dragonmyth.shared, "website");
});

test("legacy website flags can be read without using their invalid Foundry scope", () => {
  const requestedScopes = [];
  const document = {
    flags: { dragonmyth: { websiteSourceKey: "classes:0" } },
    getFlag(scope, key) {
      requestedScopes.push(scope);
      return this.flags[scope]?.[key];
    },
  };

  assert.equal(getSyncFlag(document, "websiteSourceKey"), "classes:0");
  assert.deepEqual(requestedScopes, [MODULE_ID]);
});

test("class features match Foundry items by stable identity when their order changes", () => {
  const earlier = { classEntryId: "22", classFeatureKey: "feature-a@3", name: "Subclass" };
  const later = { classEntryId: "22", classFeatureKey: "feature-b@4", name: "Ability Score Improvement" };
  const baseline = [{ name: "Manual feature" }, later, earlier];
  const documents = [
    { sourceKey: "features:0", name: "Manual feature" },
    { sourceKey: classFeatureSyncKey(earlier), name: "Subclass" },
    { sourceKey: classFeatureSyncKey(later), name: "Ability Score Improvement" },
  ].map((item) => ({
    name: item.name,
    flags: { [MODULE_ID]: { websiteSourceKey: item.sourceKey } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
  }));

  const matched = managedEntryDocuments(documents, "features", baseline);

  assert.deepEqual(matched.map(({ document }) => document.name), [
    "Manual feature", "Ability Score Improvement", "Subclass",
  ]);
  assert.deepEqual(matched.map(({ baseline: entry }) => entry.name), [
    "Manual feature", "Ability Score Improvement", "Subclass",
  ]);
});

test("class progression grants retain stable Item and ActiveEffect identities", () => {
  const baseline = [
    { name: "Manual item" },
    { classProgressionKey: "grant-feature-1", progressionCategoryId: "features", name: "Bardic Inspiration" },
    { classProgressionKey: "grant-effect-1", progressionCategoryId: "conditions", name: "Blessed" },
  ];
  const items = [
    { key: "items:0", name: "Manual item" },
    { key: classProgressionSyncKey(baseline[1]), name: "Bardic Inspiration" },
  ].map((item) => ({
    name: item.name,
    flags: { [MODULE_ID]: { websiteSourceKey: item.key } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
  }));
  const effects = [{
    name: "Blessed",
    flags: { [MODULE_ID]: { websiteSourceKey: classProgressionSyncKey(baseline[2]) } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
  }];

  assert.deepEqual(managedEntryDocuments(items, "items", baseline.slice(0, 2))
    .map(({ document }) => document.name), ["Manual item", "Bardic Inspiration"]);
  assert.deepEqual(managedEntryDocuments(effects, "effects", [baseline[2]])
    .map(({ document }) => document.name), ["Blessed"]);
});
