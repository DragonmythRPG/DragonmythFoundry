export const MODULE_ID = "dragonmyth-sync";
const WEBSITE_FLAG_SCOPE = "dragonmyth";

export function getSyncFlag(document, key) {
  return document.getFlag(MODULE_ID, key) ?? document.flags?.[WEBSITE_FLAG_SCOPE]?.[key];
}

export function classFeatureSyncKey(feature) {
  if (!feature?.classEntryId || !feature?.classFeatureKey) return null;
  return `class-features:${JSON.stringify([String(feature.classEntryId), String(feature.classFeatureKey)])}`;
}

export function classProgressionSyncKey(entry) {
  if (!entry?.classProgressionKey || !entry?.progressionCategoryId) return null;
  return `class-progression:${JSON.stringify([String(entry.progressionCategoryId), String(entry.classProgressionKey)])}`;
}

export function managedEntryDocuments(documents, group, baseline) {
  const byIndex = new Map();
  const byStableKey = new Map();
  for (const document of documents) {
    const key = getSyncFlag(document, "websiteSourceKey");
    const match = typeof key === "string" && new RegExp(`^${group}:(\\d+)$`).exec(key);
    if (match) {
      const index = Number(match[1]);
      if (byIndex.has(index)) {
        throw new Error(`The linked Actor contains duplicate Dragonmyth ${group} entries.`);
      }
      byIndex.set(index, document);
    } else if (typeof key === "string" &&
        (key.startsWith("class-progression:") || (group === "features" && key.startsWith("class-features:")))) {
      if (byStableKey.has(key)) {
        throw new Error(`The linked Actor contains duplicate Dragonmyth ${group} entries.`);
      }
      byStableKey.set(key, document);
    }
  }
  const entries = [];
  const maximum = Math.max(baseline.length, ...[...byIndex.keys()].map((index) => index + 1));
  for (let index = 0; index < maximum; index += 1) {
    const baselineEntry = baseline[index] || {};
    const stableKey = classProgressionSyncKey(baselineEntry) ||
      (group === "features" ? classFeatureSyncKey(baselineEntry) : null);
    const document = stableKey ? byStableKey.get(stableKey) : byIndex.get(index);
    if (document) entries.push({ document, baseline: baselineEntry });
  }
  return entries;
}

export function normalizeSyncFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return {};

  const normalized = { ...flags };
  const websiteFlags = normalized[WEBSITE_FLAG_SCOPE];
  if (!websiteFlags || typeof websiteFlags !== "object" || Array.isArray(websiteFlags)) {
    return normalized;
  }

  const moduleFlags = normalized[MODULE_ID];
  normalized[MODULE_ID] = {
    ...websiteFlags,
    ...(moduleFlags && typeof moduleFlags === "object" && !Array.isArray(moduleFlags)
      ? moduleFlags
      : {}),
  };
  delete normalized[WEBSITE_FLAG_SCOPE];
  return normalized;
}

export function normalizeSyncActorData(actor) {
  return {
    ...actor,
    flags: normalizeSyncFlags(actor.flags),
    items: Array.isArray(actor.items)
      ? actor.items.map((item) => ({ ...item, flags: normalizeSyncFlags(item.flags) }))
      : actor.items,
    effects: Array.isArray(actor.effects)
      ? actor.effects.map((effect) => ({ ...effect, flags: normalizeSyncFlags(effect.flags) }))
      : actor.effects,
  };
}
