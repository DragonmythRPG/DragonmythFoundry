export function poolKey(pool) {
  return JSON.stringify([pool.scope, pool.ownerInstanceId || null, pool.id]);
}

export function removeConsumedEquipmentPools(pools, previousItems, remainingItems) {
  const remaining = new Set(remainingItems.map((item) => item.instanceId));
  const consumed = new Set(previousItems.filter((item) =>
    ["ammunition", "consumable", "potion"].includes(item.itemData?.type || item.type) && !remaining.has(item.instanceId))
    .map((item) => item.instanceId));
  return pools.filter((pool) => !pool.ownerInstanceId || !consumed.has(pool.ownerInstanceId));
}

async function amount(value, roll) {
  const result = typeof value === "number" ? value : await roll(value);
  if (!Number.isInteger(result) || result < 1 || result > 100000) {
    throw new Error("A resource amount must resolve to an integer between 1 and 100000.");
  }
  return result;
}

export async function spendActionResources(pools, action, ownerInstanceId, roll) {
  const result = structuredClone(pools);
  const totals = new Map();
  for (const cost of action.costs || []) {
    const key = poolKey({ scope: cost.poolScope, ownerInstanceId: cost.poolScope === "owner" ? ownerInstanceId : null, id: cost.poolId });
    totals.set(key, (totals.get(key) || 0) + await amount(cost.quantity, roll));
  }
  for (const [key, quantity] of totals) {
    const pool = result.find((pool) => poolKey(pool) === key);
    if (!pool) throw new Error(`This action requires an unavailable resource pool: ${JSON.parse(key)[2]}.`);
    if (pool.current < quantity) throw new Error(`Not enough ${pool.name}: this use requires ${quantity}, but only ${pool.current} remain.`);
    pool.current -= quantity;
  }
  return result;
}

export async function recoverResourcePools(pools, trigger, roll) {
  const result = structuredClone(pools);
  for (const pool of result) {
    const recovery = (pool.recovery || []).find((rule) => rule.trigger === trigger);
    if (!recovery) continue;
    pool.current = recovery.amount.type === "full" ? pool.maximumValue
      : Math.min(pool.maximumValue, pool.current + await amount(
        recovery.amount.type === "dice" ? recovery.amount.formula : recovery.amount.value, roll));
  }
  return result;
}
