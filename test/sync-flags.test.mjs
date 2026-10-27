import test from "node:test";
import assert from "node:assert/strict";
import {
  getSyncFlag,
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
