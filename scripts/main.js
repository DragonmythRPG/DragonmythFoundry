"use strict";

const MODULE_ID = "dragonmyth-sync";
const SYNC_INTERVAL_MS = 15_000;
const TOKEN_KEY_PREFIX = `${MODULE_ID}:token:`;
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

function snapshot(actor) {
  const current = actor.system?.attributes?.hp?.value;
  const maximum = actor.system?.attributes?.hp?.max;
  if (
    typeof actor.name !== "string" ||
    !Number.isInteger(current) ||
    !Number.isInteger(maximum)
  ) {
    throw new Error("The selected Actor does not have the expected D&D 5e name and HP fields.");
  }
  return { name: actor.name, hpCurrent: current, hpMax: maximum };
}

function sameSnapshot(left, right) {
  return left?.name === right?.name &&
    left?.hpCurrent === right?.hpCurrent &&
    left?.hpMax === right?.hpMax;
}

function saveBaseline(remoteVersion, current) {
  activeLink.version = remoteVersion;
  activeLink.baseline = current;
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
      targetActor = await Actor.create({
        name: character.name,
        type: "character",
        system: {
          attributes: {
            hp: { value: character.hpCurrent, max: character.hpMax },
          },
        },
        ownership: { default: 0, [ownerId]: 3 },
        flags: {
          [MODULE_ID]: { websiteCharacterId: character.id },
        },
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
    await applyWebsiteState(targetActor, character);
    activeLink = {
      token: paired.token,
      actorUuid: targetActor.uuid,
      characterId: character.id,
      worldId: game.world.id,
      websiteUrl: website,
      version: character.version,
      baseline: {
        name: character.name,
        hpCurrent: character.hpCurrent,
        hpMax: character.hpMax,
      },
    };
    syncPaused = false;
    saveLink(activeLink);
    await game.settings.set(MODULE_ID, "pairingCode", "");
    ui.notifications.info(
      `${character.name} is linked to Foundry. The website’s name and HP were used as the initial values.`,
    );
    startSync();
  } catch (error) {
    notifyError(error);
  } finally {
    pairingBusy = false;
  }
}

async function applyWebsiteState(actor, character) {
  const current = snapshot(actor);
  const update = {};
  if (current.name !== character.name) update.name = character.name;
  if (current.hpCurrent !== character.hpCurrent) {
    update["system.attributes.hp.value"] = character.hpCurrent;
  }
  if (current.hpMax !== character.hpMax) {
    update["system.attributes.hp.max"] = character.hpMax;
  }
  if (Object.keys(update).length) await actor.update(update);
}

async function reconcile() {
  if (!activeLink || syncBusy || syncPaused) return;
  syncBusy = true;
  try {
    const actor = await fromUuid(activeLink.actorUuid);
    if (!actor || actor.documentName !== "Actor") {
      throw new Error("The linked Foundry Actor could not be found.");
    }
    const local = snapshot(actor);
    const { character } = await request("/state", {
      token: activeLink.token,
      baseUrl: activeLink.websiteUrl,
    });
    const remote = {
      name: character.name,
      hpCurrent: character.hpCurrent,
      hpMax: character.hpMax,
    };
    const baseline = activeLink.baseline;
    if (!baseline) {
      await applyWebsiteState(actor, character);
      saveBaseline(character.version, remote);
      return;
    }

    const localChanged = !sameSnapshot(local, baseline);
    const websiteChanged = !sameSnapshot(remote, baseline);
    if (localChanged && websiteChanged && !sameSnapshot(local, remote)) {
      syncPaused = true;
      throw new Error("Both Foundry and the website changed this character since the last sync. Resolve the conflict, then pair it again.");
    }
    if (websiteChanged && !localChanged) {
      await applyWebsiteState(actor, character);
      saveBaseline(character.version, remote);
      return;
    }
    if (localChanged && !websiteChanged) {
      const result = await request("/state", {
        method: "PATCH",
        token: activeLink.token,
        baseUrl: activeLink.websiteUrl,
        body: { expectedVersion: character.version, changes: local },
      });
      const saved = result.character;
      saveBaseline(saved.version, {
        name: saved.name,
        hpCurrent: saved.hpCurrent,
        hpMax: saved.hpMax,
      });
      return;
    }
    saveBaseline(character.version, remote);
  } catch (error) {
    if (error.status === 401 || error.status === 409) syncPaused = true;
    notifyError(error);
  } finally {
    syncBusy = false;
  }
}

function relevantUpdate(changes) {
  return ["name", "system.attributes.hp.value", "system.attributes.hp.max"]
    .some((key) =>
      Object.hasOwn(changes, key) ||
      foundry.utils.getProperty(changes, key) !== undefined,
    );
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
