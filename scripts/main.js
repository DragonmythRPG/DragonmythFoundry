import { resolveSyncChanges } from "./sync-state.mjs";

const MODULE_ID = "dragonmyth-sync";
const SYNC_INTERVAL_MS = 15_000;
const TOKEN_KEY_PREFIX = `${MODULE_ID}:token:`;
const SYNC_SCHEMA_VERSION = 2;
const WEBSITE_FLAG_SCOPE = "dragonmyth";
const PRIVATE_NOTES_HEADING = "Dragonmyth Private Notes";
const DND5E_CONDITIONS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
];
const FOUNDRY_SKILL_IDS = {
  acrobatics: "acr",
  animalHandling: "ani",
  arcana: "arc",
  athletics: "ath",
  deception: "dec",
  history: "his",
  insight: "ins",
  intimidation: "itm",
  investigation: "inv",
  medicine: "med",
  nature: "nat",
  perception: "prc",
  performance: "prf",
  persuasion: "per",
  religion: "rel",
  sleightOfHand: "slt",
  stealth: "ste",
  survival: "sur",
};
const WEBSITE_SKILL_IDS = Object.fromEntries(
  Object.entries(FOUNDRY_SKILL_IDS).map(([skill, foundryId]) => [foundryId, skill]),
);
const SYNCED_SYSTEM_DATA_FIELDS = [
  "speed",
  "hitDice",
  "savingThrowProficiencies",
  "skillProficiencies",
  "skillExpertise",
  "skillProficiencyLevels",
  "inspiration",
  "deathSaves",
  "originalClass",
  "speciesTraits",
  "backgroundFeature",
  "personality",
  "currencyCp",
  "items",
  "features",
  "feats",
  "spells",
  "effects",
  "conditions",
];
let ready = false;
let syncTimer = null;
let syncBusy = false;
let syncPaused = false;
let pairingBusy = false;
let activeLink = null;
let lastNotificationAt = 0;

function tokenKey() {
  return `${TOKEN_KEY_PREFIX}${game.world.id}:${game.user.id}`;
}

function saveLink(link) {
  sessionStorage.setItem(tokenKey(), JSON.stringify(link));
}

function readLink() {
  const saved = sessionStorage.getItem(tokenKey());
  if (!saved) return null;
  try {
    const link = JSON.parse(saved);
    if (
      typeof link.token !== "string" ||
      typeof link.actorUuid !== "string" ||
      link.worldId !== game.world.id
    ) {
      throw new Error("The saved Foundry sync link is invalid.");
    }
    if (
      link.syncSchemaVersion !== SYNC_SCHEMA_VERSION ||
      !link.baseline?.website ||
      !link.baseline?.actor
    ) {
      link.syncSchemaVersion = SYNC_SCHEMA_VERSION;
      link.baseline = null;
    }
    return link;
  } catch (error) {
    sessionStorage.removeItem(tokenKey());
    throw error;
  }
}

function siteUrl() {
  const value = game.settings.get(MODULE_ID, "websiteUrl").trim();
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("The website URL must use HTTPS.");
  }
  return url.origin;
}

async function request(path, { method = "GET", token, body, baseUrl = siteUrl() } = {}) {
  const response = await fetch(`${baseUrl}/api/foundry-sync${path}`, {
    method,
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Website sync failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function websiteState(character) {
  return {
    name: character.name,
    race: character.race,
    className: character.className,
    subclass: character.subclass,
    level: character.level,
    background: character.background,
    alignment: character.alignment,
    hpCurrent: character.hpCurrent,
    hpMax: character.hpMax,
    armorClass: character.armorClass,
    abilities: clone(character.abilities),
    biography: clone(character.biography),
    systemData: clone(character.systemData),
  };
}

function assertSyncState(character) {
  if (
    !character ||
    character.systemId !== "dnd5e-2024" ||
    !character.foundryActor?.system ||
    !Array.isArray(character.foundryActor.items) ||
    !Array.isArray(character.foundryActor.effects) ||
    !character.biography ||
    !character.systemData
  ) {
    throw new Error("The Dragonmyth website needs its full-field Foundry sync update before this module version can sync.");
  }
}

function htmlToText(html) {
  const withLineBreaks = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|section)>/gi, "\n");
  const parsed = new DOMParser().parseFromString(withLineBreaks, "text/html");
  return (parsed.body.innerText ?? parsed.body.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToHtml(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => `<p>${line ? foundry.utils.escapeHTML(line) : "<br>"}</p>`)
    .join("");
}

function biographyHtml(character) {
  const backstory = character.foundryActor.system.details.biography.value || "";
  const notes = character.biography?.notes || "";
  if (!notes) return backstory;
  return `${backstory}<section data-dragonmyth-private-notes="true"><h3>${PRIVATE_NOTES_HEADING}</h3>${plainTextToHtml(notes)}</section>`;
}

function splitBiography(html, fallbackNotes) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  let notesSection = parsed.body.querySelector('[data-dragonmyth-private-notes="true"]');
  if (!notesSection) {
    notesSection = [...parsed.body.querySelectorAll("h1, h2, h3, h4")]
      .find((heading) => heading.textContent.trim() === PRIVATE_NOTES_HEADING)
      ?.parentElement;
  }
  if (!notesSection) {
    return { backstory: htmlToText(parsed.body.innerHTML), notes: fallbackNotes };
  }
  notesSection.querySelectorAll("h1, h2, h3, h4").forEach((heading) => {
    if (heading.textContent.trim() === PRIVATE_NOTES_HEADING) heading.remove();
  });
  const notes = htmlToText(notesSection.innerHTML);
  notesSection.remove();
  return { backstory: htmlToText(parsed.body.innerHTML), notes };
}

function sourceIndex(document, group) {
  const key = document.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceKey");
  const match = typeof key === "string" && new RegExp(`^${group}:(\\d+)$`).exec(key);
  return match ? Number(match[1]) : null;
}

function conditionDocumentId(condition) {
  const id = `dnd5e${condition}`;
  return id.length >= 16 ? id.slice(0, 16) : id.padEnd(16, "0");
}

function readWebsiteConditions(actor) {
  return DND5E_CONDITIONS.filter((condition) => {
    const key = `conditions:${condition}`;
    const document = actor.effects.contents.find(
      (effect) => effect.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceKey") === key,
    ) || actor.effects.get(conditionDocumentId(condition));
    return document && !document.disabled;
  });
}

function readManagedEntries(documents, group, baseline, convert) {
  const byIndex = new Map();
  for (const document of documents) {
    const index = sourceIndex(document, group);
    if (index === null) continue;
    if (byIndex.has(index)) {
      throw new Error(`The linked Actor contains duplicate Dragonmyth ${group} entries.`);
    }
    byIndex.set(index, document);
  }
  const entries = [];
  const maximum = Math.max(baseline.length, ...[...byIndex.keys()].map((index) => index + 1));
  for (let index = 0; index < maximum; index += 1) {
    const document = byIndex.get(index);
    if (document) {
      const entry = convert(document, baseline[index] || {});
      if (entry !== null && entry !== undefined) entries.push(entry);
    }
  }
  return entries;
}

function itemToWebsite(document, baseline) {
  const system = document.system || {};
  const sourceType = document.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceType");
  const websiteItemData = document.getFlag(WEBSITE_FLAG_SCOPE, "websiteItemData") || baseline.itemData;
  const websiteArmorData = document.getFlag(WEBSITE_FLAG_SCOPE, "websiteArmorData") || baseline.armorData;
  const result = {
    ...baseline,
    name: document.name,
    ...(typeof sourceType === "string" ? { type: sourceType } : {}),
    quantity: Number.isInteger(system.quantity) ? system.quantity : baseline.quantity,
    weight: Number.isFinite(system.weight) ? system.weight : baseline.weight,
    equipped: typeof system.equipped === "boolean" ? system.equipped : baseline.equipped,
    description: typeof system.description?.value === "string"
      ? htmlToText(system.description.value)
      : baseline.description,
  };
  if (websiteItemData) result.itemData = clone(websiteItemData);
  const weaponAction = result.itemData?.weapon?.actions?.[0];
  if (weaponAction) {
    const rangeUnits = system.range?.units;
    const rangeMultiplier = rangeUnits === "m" ? 3.28084 : 1;
    if (Number.isFinite(Number(system.range?.value))) {
      weaponAction.normalRange = Math.round(Number(system.range.value) * rangeMultiplier);
      weaponAction.longRange = Math.round(Number(system.range.long || 0) * rangeMultiplier);
      if (weaponAction.normalRange > 0) weaponAction.attackType = "ranged";
    }
    if (typeof system.ammunition?.type === "string" && system.ammunition.type) {
      weaponAction.ammunitionSubtype = system.ammunition.type;
    }
    const damage = system.damage?.base;
    if (damage) {
      const dice = damage.number > 0 && damage.denomination > 0
        ? `${damage.number}d${damage.denomination}`
        : String(damage.bonus || "");
      const modifier = /^\d+$/.test(String(damage.bonus || ""))
        ? Number(damage.bonus)
        : 0;
      if (dice && DAMAGE_EXPRESSION.test(dice)) {
        const types = [...(damage.types || [])];
        weaponAction.damage = [{
          ...(weaponAction.damage?.[0] || {}),
          dice,
          modifier,
          type: types[0] || weaponAction.damage?.[0]?.type || "slashing",
        }];
      }
    }
    if (system.properties) {
      weaponAction.properties = [...system.properties].map(websiteWeaponProperty);
    }
  }
  if (system.armor && Number.isInteger(system.armor.value) && system.type?.value) {
    const dexterity = Number(system.armor.dex) || 0;
    result.armorData = {
      kind: system.type.value,
      base: system.armor.value,
      addsDex: dexterity !== 0,
      maxDex: dexterity > 0 ? dexterity : null,
    };
    if (result.itemData?.armor) {
      const dexterityMode = dexterity === 0 ? "none" : dexterity < 0 ? "full" : "capped";
      result.itemData.armor = {
        ...result.itemData.armor,
        kind: system.type.value,
        armorClass: system.armor.value,
        requiredStrength: Number.isInteger(system.strength)
          ? system.strength
          : result.itemData.armor.requiredStrength,
        dexterity: dexterityMode,
        maximumDexterity: dexterity > 0 ? dexterity : null,
        stealthDisadvantage: Array.from(system.properties || []).includes("stealthDisadvantage"),
      };
    }
  } else if (websiteArmorData) {
    result.armorData = clone(websiteArmorData);
  }
  return result;
}

const DAMAGE_EXPRESSION = /^(?:\d{1,3}d(?:4|6|8|10|12|20|100)|\d{1,4})$/;

function websiteWeaponProperty(value) {
  const properties = {
    amm: "Ammunition",
    cle: "Cleave",
    fin: "Finesse",
    grz: "Graze",
    hvy: "Heavy",
    lgt: "Light",
    lod: "Loading",
    nic: "Nick",
    psh: "Push",
    rch: "Reach",
    sap: "Sap",
    slo: "Slow",
    thr: "Thrown",
    top: "Topple",
    two: "Two-Handed",
    ver: "Versatile",
    vex: "Vex",
  };
  return properties[value] || value;
}

function featureToWebsite(document, baseline) {
  const system = document.system || {};
  return {
    ...baseline,
    name: document.name,
    uses: Number.isInteger(system.uses?.value) ? system.uses.value : baseline.uses,
    maxUses: Number.isInteger(system.uses?.max) ? system.uses.max : baseline.maxUses,
    recovery: typeof system.uses?.recovery === "string" ? system.uses.recovery : baseline.recovery,
    description: typeof system.description?.value === "string"
      ? htmlToText(system.description.value)
      : baseline.description,
  };
}

function spellSchoolLabel(value, baseline) {
  const labels = {
    abj: "abjuration",
    con: "conjuration",
    div: "divination",
    enc: "enchantment",
    evo: "evocation",
    ill: "illusion",
    nec: "necromancy",
    trs: "transmutation",
  };
  return labels[value] || (typeof value === "string" ? value : baseline);
}

function activationLabel(activation, baseline) {
  if (!activation || typeof activation.type !== "string") return baseline;
  if (activation.type === "special") return activation.condition || baseline;
  const labels = {
    action: "action",
    bonus: "bonus action",
    reaction: "reaction",
    turn: "turn",
    round: "round",
    minute: "minute",
    hour: "hour",
    day: "day",
  };
  const label = labels[activation.type];
  if (!label) return baseline;
  const count = Number.isInteger(activation.value) && activation.value > 0 ? activation.value : 1;
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function rangeLabel(range, baseline) {
  if (!range || typeof range.units !== "string") return baseline;
  const special = { self: "Self", touch: "Touch", spec: "Special", any: "Unlimited" };
  if (special[range.units]) return special[range.units];
  const value = Number(range.value);
  if (!Number.isFinite(value)) return range.special || baseline;
  const unit = range.units === "ft" ? "ft." : range.units;
  return `${value} ${unit}`;
}

function durationLabel(duration, baseline) {
  if (!duration || typeof duration.units !== "string") return baseline;
  if (duration.units === "inst") return "Instantaneous";
  if (duration.units === "perm") return "Until dispelled";
  if (duration.units === "spec") return duration.special || baseline;
  const value = Number(duration.value);
  if (!Number.isFinite(value)) return duration.special || baseline;
  return `${value} ${duration.units}${value === 1 ? "" : "s"}`;
}

function spellToWebsite(document, baseline) {
  const system = document.system || {};
  const rangeUnit = ["ft", "m", "squares"].includes(system.range?.units)
    ? system.range.units
    : baseline.rangeUnit;
  return {
    ...baseline,
    name: document.name,
    level: Number.isInteger(system.level) ? system.level : baseline.level,
    school: spellSchoolLabel(system.school, baseline.school),
    prepared: Number(system.prepared) > 0,
    castingTime: activationLabel(system.activation, baseline.castingTime),
    range: rangeLabel(system.range, baseline.range),
    rangeUnit,
    duration: durationLabel(system.duration, baseline.duration),
    description: typeof system.description?.value === "string"
      ? htmlToText(system.description.value)
      : baseline.description,
  };
}

function effectToWebsite(document, baseline) {
  return {
    ...baseline,
    name: document.name,
    source: typeof document.origin === "string" ? document.origin : baseline.source,
    duration: typeof document.duration?.label === "string"
      ? document.duration.label
      : baseline.duration,
    active: !document.disabled,
    description: typeof document.description === "string"
      ? htmlToText(document.description)
      : baseline.description,
  };
}

function snapshot(actor, baseline) {
  if (!actor || typeof actor.name !== "string" || !baseline) {
    throw new Error("The linked Foundry Actor could not be read.");
  }
  const state = clone(baseline);
  const system = actor.system || {};
  const attributes = system.attributes || {};
  const details = system.details || {};
  const deathSaves = attributes.death || {};
  const syncedSystemData = actor.getFlag(MODULE_ID, "websiteSystemData");
  if (syncedSystemData) state.systemData = clone(syncedSystemData);
  state.name = actor.name;
  state.race = typeof details.race === "string" ? details.race : details.race?.name ?? state.race;
  state.background = typeof details.background === "string"
    ? details.background
    : details.background?.name ?? state.background;
  state.alignment = typeof details.alignment === "string" ? details.alignment : state.alignment;
  state.hpCurrent = Number.isInteger(attributes.hp?.value) ? attributes.hp.value : state.hpCurrent;
  state.hpMax = Number.isInteger(attributes.hp?.max) ? attributes.hp.max : state.hpMax;
  state.armorClass = Number.isInteger(attributes.ac?.value)
    ? attributes.ac.value
    : Number.isInteger(attributes.ac?.override) ? attributes.ac.override : state.armorClass;
  state.abilities = { ...state.abilities };
  for (const ability of Object.keys(state.abilities)) {
    const value = system.abilities?.[ability]?.value;
    if (Number.isInteger(value)) state.abilities[ability] = value;
  }

  const biographyFlags = actor.getFlag(WEBSITE_FLAG_SCOPE, "biography") || {};
  for (const field of ["hair", "eyes", "skin", "height", "weight", "age", "gender"]) {
    if (typeof details[field] === "string") state.biography[field] = details[field];
  }
  if (typeof biographyFlags.pronouns === "string") state.biography.pronouns = biographyFlags.pronouns;
  if (typeof details.appearance === "string") state.biography.appearance = details.appearance;
  const notesFlag = actor.getFlag(MODULE_ID, "websitePrivateNotes");
  const biography = splitBiography(
    details.biography?.value,
    typeof notesFlag === "string" ? notesFlag : state.biography.notes,
  );
  state.biography.backstory = biography.backstory;
  state.biography.notes = biography.notes;

  const systemData = state.systemData;
  if (Number.isInteger(attributes.movement?.walk)) systemData.speed = attributes.movement.walk;
  if (typeof attributes.inspiration === "boolean") systemData.inspiration = attributes.inspiration;
  if (typeof attributes.spellcasting === "string") {
    systemData.spellcastingAbility = attributes.spellcasting;
  }
  if (Number.isInteger(deathSaves.success) && Number.isInteger(deathSaves.failure)) {
    systemData.deathSaves = {
      successes: deathSaves.success,
      failures: deathSaves.failure,
    };
  }
  systemData.savingThrowProficiencies = Object.entries(system.abilities || {})
    .filter(([, ability]) => Number(ability.proficient) > 0)
    .map(([ability]) => ability);
  const skillLevels = Object.entries(WEBSITE_SKILL_IDS).map(([foundryId, skill]) => {
    const value = Number(system.skills?.[foundryId]?.value) || 0;
    const level = value >= 2 ? "expertise"
      : value >= 1 ? "proficient"
        : value >= 0.5 ? "half"
          : "none";
    return { skill, level };
  });
  systemData.skillProficiencyLevels = skillLevels;
  systemData.skillProficiencies = skillLevels
    .filter(({ level }) => level === "proficient" || level === "expertise")
    .map(({ skill }) => skill);
  systemData.skillExpertise = skillLevels
    .filter(({ level }) => level === "expertise")
    .map(({ skill }) => skill);
  const classItem = actor.items.contents.find(
    (item) => item.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceKey") === "classes:0",
  );
  if (classItem) {
    const classSystem = classItem.system || {};
    state.className = classItem.name;
    state.level = Number.isInteger(classSystem.levels) ? classSystem.levels : state.level;
    const denomination = Number.parseInt(classSystem.hd?.denomination?.slice(1), 10);
    if ([4, 6, 8, 10, 12, 20].includes(denomination) && Number.isInteger(classSystem.hd?.spent)) {
      systemData.hitDice = {
        die: `d${denomination}`,
        current: Math.max(0, state.level - classSystem.hd.spent),
      };
    }
  } else if (state.className) {
    state.className = "";
    state.subclass = "";
  }
  const websiteFlags = actor.getFlag(MODULE_ID, "websiteData") || {};
  if (typeof websiteFlags.subclass === "string") state.subclass = websiteFlags.subclass;
  if (typeof websiteFlags.originalClass === "string") systemData.originalClass = websiteFlags.originalClass;
  if (typeof websiteFlags.speciesTraits === "string") systemData.speciesTraits = websiteFlags.speciesTraits;
  if (typeof websiteFlags.backgroundFeature === "string") systemData.backgroundFeature = websiteFlags.backgroundFeature;
  const traitValues = (path) => [...(foundry.utils.getProperty(system, path)?.value || [])];
  if (system.traits?.armorProf?.value !== undefined) {
    systemData.armorProficiencies = traitValues("traits.armorProf")
      .map((value) => traitLabel(value, "armor", state.systemData.armorProficiencies));
  }
  if (system.traits?.weaponProf?.value !== undefined) {
    systemData.weaponProficiencies = traitValues("traits.weaponProf")
      .map((value) => traitLabel(value, "weapon", state.systemData.weaponProficiencies));
  }
  if (system.traits?.languages?.value !== undefined) {
    systemData.languages = traitValues("traits.languages")
      .map((value) => traitLabel(value, "language", state.systemData.languages));
  }
  systemData.personality = {
    trait: typeof details.trait === "string" ? details.trait : systemData.personality.trait,
    ideal: typeof details.ideal === "string" ? details.ideal : systemData.personality.ideal,
    bond: typeof details.bond === "string" ? details.bond : systemData.personality.bond,
    flaw: typeof details.flaw === "string" ? details.flaw : systemData.personality.flaw,
  };
  const currency = system.currency || {};
  systemData.currencyCp =
    (Number(currency.pp) || 0) * 1000 +
    (Number(currency.gp) || 0) * 100 +
    (Number(currency.ep) || 0) * 50 +
    (Number(currency.sp) || 0) * 10 +
    (Number(currency.cp) || 0);
  systemData.items = readManagedEntries(actor.items.contents, "items", systemData.items, itemToWebsite);
  systemData.features = readManagedEntries(actor.items.contents, "features", systemData.features, featureToWebsite);
  systemData.feats = readManagedEntries(actor.items.contents, "feats", systemData.feats, featureToWebsite);
  systemData.spells = readManagedEntries(actor.items.contents, "spells", systemData.spells, spellToWebsite);
  systemData.effects = readManagedEntries(actor.effects.contents, "effects", systemData.effects, effectToWebsite);
  systemData.conditions = readWebsiteConditions(actor);
  return state;
}

function traitLabel(value, category, currentValues) {
  const aliases = {
    armor: { light: "Light armor", medium: "Medium armor", heavy: "Heavy armor", shield: "Shields" },
    weapon: { sim: "Simple weapons", mar: "Martial weapons" },
    language: {},
  };
  const current = currentValues.find((entry) =>
    entry.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "") ===
      String(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "") ||
    entry === aliases[category]?.[value],
  );
  if (current) return current;
  return aliases[category]?.[value] ||
    String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function saveBaseline(character, actor) {
  const website = websiteState(character);
  activeLink.version = character.version;
  activeLink.syncSchemaVersion = SYNC_SCHEMA_VERSION;
  activeLink.baseline = {
    website,
    actor: snapshot(actor, website),
  };
  saveLink(activeLink);
}

function notifyError(error) {
  console.error("Dragonmyth sync failed:", error);
  if (Date.now() - lastNotificationAt >= 60_000) {
    ui.notifications.error(`Dragonmyth sync: ${error.message}`);
    lastNotificationAt = Date.now();
  }
}

function findLinkedActor(characterId) {
  return game.actors.contents.find(
    (actor) => actor.getFlag(MODULE_ID, "websiteCharacterId") === characterId,
  ) || null;
}

function chooseFoundryOwner() {
  const players = game.users.contents.filter((user) => !user.isGM);
  if (!players.length) {
    return Promise.reject(new Error("Create a non-GM Foundry user before importing this character."));
  }
  const escape = foundry.utils.escapeHTML;
  const options = players
    .map((user) => `<option value="${escape(user.id)}">${escape(user.name)}</option>`)
    .join("");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    new Dialog({
      title: "Choose the Foundry player",
      content: `<form><div class="form-group"><label for="dragonmyth-owner">Give this player ownership of the new Actor</label><select id="dragonmyth-owner" name="ownerId">${options}</select></div></form>`,
      buttons: {
        create: {
          label: "Create Actor",
          callback: (html) => finish(html[0].querySelector('[name="ownerId"]').value),
        },
        cancel: { label: "Cancel", callback: () => finish(null) },
      },
      default: "create",
      close: () => finish(null),
    }).render(true);
  });
}

async function synchronizeEmbeddedDocuments(actor, documentName, collection, desired) {
    const existingByKey = new Map();
    for (const document of collection.contents) {
      const key = document.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceKey");
      if (typeof key !== "string") continue;
      if (existingByKey.has(key)) {
        throw new Error(`The linked Actor has duplicate synced ${documentName} documents.`);
      }
      existingByKey.set(key, document);
    }

    const desiredByKey = new Map();
    for (const source of desired) {
      const key = source.flags?.[WEBSITE_FLAG_SCOPE]?.websiteSourceKey;
      if (typeof key !== "string") {
        throw new Error(`A website-mapped ${documentName} is missing its sync key.`);
      }
      const data = clone(source);
      const condition = key.startsWith("conditions:")
        ? data.flags?.[WEBSITE_FLAG_SCOPE]?.websiteSourceType
        : null;
      if (documentName === "ActiveEffect" && typeof condition === "string") {
        data._id = conditionDocumentId(condition);
        data.flags.dnd5e = {
          ...data.flags.dnd5e,
          conditionId: condition,
        };
      }
      desiredByKey.set(key, data);
    }
    for (const [key, source] of desiredByKey) {
      if (documentName !== "ActiveEffect" || !key.startsWith("conditions:")) continue;
      const candidate = collection.get(source._id);
      if (!candidate) continue;
      for (const [existingKey, document] of existingByKey) {
        if (document.id === candidate.id && existingKey !== key) existingByKey.delete(existingKey);
      }
      existingByKey.set(key, candidate);
    }
    if (documentName === "ActiveEffect") {
      for (const condition of DND5E_CONDITIONS) {
        const key = `conditions:${condition}`;
        const candidate = collection.get(conditionDocumentId(condition));
        if (candidate && !existingByKey.has(key)) existingByKey.set(key, candidate);
      }
    }

    const deleteIds = [];
    const updateData = [];
    const createData = [];
    for (const [key, document] of existingByKey) {
      const target = desiredByKey.get(key);
      if (
        !target ||
        (target.type && document.type !== target.type) ||
        (target._id && target._id !== document.id)
      ) {
        deleteIds.push(document.id);
        existingByKey.delete(key);
      }
    }
    for (const [key, source] of desiredByKey) {
      const existing = existingByKey.get(key);
      if (existing) updateData.push({ ...clone(source), _id: existing.id });
      else createData.push(clone(source));
    }
    if (deleteIds.length) await actor.deleteEmbeddedDocuments(documentName, deleteIds);
    if (updateData.length) await actor.updateEmbeddedDocuments(documentName, updateData);
    if (createData.length) await actor.createEmbeddedDocuments(documentName, createData);
}

async function pairFromSettings() {
  if (!ready || !game.user.isGM || pairingBusy) return;
  const pairingCode = game.settings.get(MODULE_ID, "pairingCode").trim();
  if (!pairingCode) return;
  if (game.version.split(".")[0] !== "14" ||
      game.system.id !== "dnd5e" ||
      game.system.version !== "6.0.6") {
    notifyError(new Error("This prototype requires Foundry VTT v14 and D&D 5e system 6.0.6."));
    return;
  }
  if (!game.users.contents.some((user) => !user.isGM)) {
    notifyError(new Error("Create a non-GM Foundry user before importing this character."));
    return;
  }
  pairingBusy = true;
  try {
    const website = siteUrl();
    const paired = await request("/pair", {
      method: "POST",
      baseUrl: website,
      body: {
        pairingCode,
        worldId: game.world.id,
        coreVersion: game.version,
        systemId: game.system.id,
        systemVersion: game.system.version,
      },
    });
    const character = paired.character;
    assertSyncState(character);
    if (character.systemId !== "dnd5e-2024") {
      throw new Error("The website character is not a D&D 5e (2024) character.");
    }
    let targetActor = findLinkedActor(character.id);
    let createdActor = false;
    if (!targetActor) {
      const ownerId = await chooseFoundryOwner();
      if (!ownerId) {
        ui.notifications.warn("The pairing code was used. Generate a new code on the website to try again.");
        return;
      }
      const actorFlags = {
        ...character.foundryActor.flags,
        [MODULE_ID]: {
          ...character.foundryActor.flags?.[MODULE_ID],
          websiteCharacterId: character.id,
        },
      };
      targetActor = await Actor.create({
        name: character.foundryActor.name,
        type: character.foundryActor.type,
        system: {
          attributes: {
            hp: { value: character.hpCurrent, max: character.hpMax },
          },
        },
        ownership: { default: 0, [ownerId]: 3 },
        flags: actorFlags,
      });
      createdActor = true;
    }
    try {
      await request("/actor", {
        method: "POST",
        token: paired.token,
        baseUrl: website,
        body: { worldId: game.world.id, actorUuid: targetActor.uuid },
      });
      await applyWebsiteState(targetActor, character);
    } catch (error) {
      if (createdActor) {
        try {
          await targetActor.delete();
        } catch (deleteError) {
          console.error("Could not remove the unlinked Foundry Actor after pairing failed:", deleteError);
        }
      }
      throw error;
    }
    activeLink = {
      token: paired.token,
      actorUuid: targetActor.uuid,
      characterId: character.id,
      worldId: game.world.id,
      websiteUrl: website,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      baseline: null,
    };
    syncPaused = false;
    saveBaseline(character, targetActor);
    await game.settings.set(MODULE_ID, "pairingCode", "");
    ui.notifications.info(
      `${character.name} is linked to Foundry. The website’s mapped character data was used as the initial state.`,
    );
    startSync();
  } catch (error) {
    notifyError(error);
  } finally {
    pairingBusy = false;
  }
}

async function applyWebsiteState(actor, character) {
  const actorData = character.foundryActor;
  const existingOriginalClass = actor.system.details.originalClass;
  const previouslyManagedClassId = actor.getFlag(MODULE_ID, "websiteManagedClassId");
  const update = { name: actorData.name };
  for (const [path, value] of Object.entries(foundry.utils.flattenObject(actorData.system))) {
    if (path === "details.level" || path === "details.originalClass") continue;
    update[`system.${path}`] = value;
  }
  update["system.details.biography.value"] = biographyHtml(character);
  update[`flags.${WEBSITE_FLAG_SCOPE}.biography`] =
    clone(actorData.flags?.[WEBSITE_FLAG_SCOPE]?.biography || {});
  update[`flags.${MODULE_ID}.websitePrivateNotes`] = character.biography?.notes || "";
  update[`flags.${MODULE_ID}.websiteSystemData`] = clone(character.systemData);
  update[`flags.${MODULE_ID}.websiteData`] = {
    subclass: character.subclass || "",
    originalClass: character.systemData.originalClass || "",
    speciesTraits: character.systemData.speciesTraits || "",
    backgroundFeature: character.systemData.backgroundFeature || "",
  };
  if (Object.keys(update).length) await actor.update(update);
  await synchronizeEmbeddedDocuments(actor, "Item", actor.items, actorData.items || []);
  await synchronizeEmbeddedDocuments(actor, "ActiveEffect", actor.effects, actorData.effects || []);
  const primaryClass = actor.items.contents.find(
    (item) => item.getFlag(WEBSITE_FLAG_SCOPE, "websiteSourceKey") === "classes:0",
  );
  if (primaryClass) {
    await actor.update({
      "system.details.originalClass": primaryClass.id,
      [`flags.${MODULE_ID}.websiteManagedClassId`]: primaryClass.id,
    });
  } else if (previouslyManagedClassId && existingOriginalClass === previouslyManagedClassId) {
    await actor.update({
      "system.details.originalClass": "",
      [`flags.${MODULE_ID}.websiteManagedClassId`]: "",
    });
  }
}

async function reconcile() {
  if (!activeLink || syncBusy || syncPaused) return;
  syncBusy = true;
  try {
    const actor = await fromUuid(activeLink.actorUuid);
    if (!actor || actor.documentName !== "Actor") {
      throw new Error("The linked Foundry Actor could not be found.");
    }
    const { character } = await request("/state", {
      token: activeLink.token,
      baseUrl: activeLink.websiteUrl,
    });
    assertSyncState(character);
    const remote = websiteState(character);
    const baseline = activeLink.baseline;
    if (!baseline) {
      await applyWebsiteState(actor, character);
      saveBaseline(character, actor);
      return;
    }

    const local = snapshot(actor, baseline.actor);
    const decision = resolveSyncChanges(
      baseline.website,
      remote,
      baseline.actor,
      local,
    );
    if (decision.acceptedLocalChanges.length) {
      const result = await request("/state", {
        method: "PATCH",
        token: activeLink.token,
        baseUrl: activeLink.websiteUrl,
        body: {
          expectedVersion: character.version,
          changes: decision.changes,
        },
      });
      const saved = result.character;
      await applyWebsiteState(actor, saved);
      if (decision.conflicts.length) {
        ui.notifications.info("The website version took priority for fields changed on both sides.");
      }
      saveBaseline(saved, actor);
      return;
    }
    if (decision.websiteChanges.length) await applyWebsiteState(actor, character);
    saveBaseline(character, actor);
  } catch (error) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      (error.status === 409 && !error.message.startsWith("This character was changed somewhere else."))
    ) {
      syncPaused = true;
    }
    notifyError(error);
  } finally {
    syncBusy = false;
  }
}

function relevantUpdate(changes) {
  return Object.hasOwn(changes, "name") ||
    Object.hasOwn(changes, "system") ||
    Object.hasOwn(changes, "flags");
}

function startSync() {
  if (syncTimer) clearInterval(syncTimer);
  void reconcile();
  syncTimer = setInterval(() => void reconcile(), SYNC_INTERVAL_MS);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "websiteUrl", {
    name: "Dragonmyth website URL",
    hint: "HTTPS URL of the website that issued the character pairing code.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "pairingCode", {
    name: "One-time character pairing code",
    hint: "Paste the code from the character editor. It is cleared after pairing.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: () => {
      if (ready) void pairFromSettings();
    },
  });
});

Hooks.once("ready", () => {
  ready = true;
  if (!game.user.isGM) return;
  try {
    activeLink = readLink();
    if (activeLink) {
      activeLink.websiteUrl = siteUrl();
      startSync();
    } else {
      ui.notifications.info(
        "Set the Dragonmyth website URL and one-time pairing code in Configure Settings to import a character.",
      );
    }
    void pairFromSettings();
  } catch (error) {
    notifyError(error);
  }
});

Hooks.on("updateActor", (actor, changes) => {
  if (
    !game.user.isGM ||
    !activeLink ||
    syncPaused ||
    actor.uuid !== activeLink.actorUuid ||
    !relevantUpdate(changes)
  ) {
    return;
  }
  void reconcile();
});
