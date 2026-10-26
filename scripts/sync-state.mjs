function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedPaths(left, right) {
  const paths = [];
  for (const key of Object.keys(left)) {
    if (["abilities", "biography", "systemData"].includes(key)) {
      const nestedKeys = new Set([
        ...Object.keys(left[key] || {}),
        ...Object.keys(right[key] || {}),
      ]);
      for (const nested of nestedKeys) {
        if (!sameValue(left[key]?.[nested], right[key]?.[nested])) paths.push(`${key}.${nested}`);
      }
    } else if (!sameValue(left[key], right[key])) {
      paths.push(key);
    }
  }
  return paths;
}

function changesForPaths(state, paths) {
  const changes = {};
  for (const path of paths) {
    const separator = path.indexOf(".");
    if (separator === -1) {
      changes[path] = structuredClone(state[path]);
      continue;
    }
    const root = path.slice(0, separator);
    const field = path.slice(separator + 1);
    changes[root] ??= {};
    changes[root][field] = structuredClone(state[root][field]);
  }
  return changes;
}

export function resolveSyncChanges(baselineWebsite, website, baselineActor, actor) {
  const websiteChanges = changedPaths(baselineWebsite, website);
  const localChanges = changedPaths(baselineActor, actor);
  const websiteChanged = new Set(websiteChanges);
  const acceptedLocalChanges = localChanges.filter((path) => !websiteChanged.has(path));
  const conflicts = localChanges.filter((path) => websiteChanged.has(path));
  return {
    websiteChanges,
    localChanges,
    acceptedLocalChanges,
    conflicts,
    changes: changesForPaths(actor, acceptedLocalChanges),
  };
}
