export const MODULE_ID = "dragonmyth-sync";
const WEBSITE_FLAG_SCOPE = "dragonmyth";

export function getSyncFlag(document, key) {
  return document.getFlag(MODULE_ID, key) ?? document.flags?.[WEBSITE_FLAG_SCOPE]?.[key];
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
