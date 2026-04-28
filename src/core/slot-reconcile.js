import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSlotState } from './state-store.js';
import { readSlotAuthIdentity } from './slot-identity.js';
import { pathExists } from './fs.js';

const AUTO_SLOT_RE = /^slot-(\d+)$/;

function isMainSlot(slot) {
  return slot?.id === 'main';
}

function isPendingAuthSlot(state, slotId) {
  return state?.slots?.[slotId]?.status === 'pending_auth';
}

function parseAutoIndex(slotId) {
  const m = String(slotId || '').match(AUTO_SLOT_RE);
  return m ? Number(m[1]) : null;
}

function sortSlotsForIdentityDedup(slots) {
  return [...slots].sort((a, b) => {
    if (isMainSlot(a) && !isMainSlot(b)) return -1;
    if (!isMainSlot(a) && isMainSlot(b)) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortAutoSlots(slots) {
  return [...slots].sort((a, b) => {
    const ia = parseAutoIndex(a.id);
    const ib = parseAutoIndex(b.id);
    if (ia !== null && ib !== null) return ia - ib;
    if (ia !== null) return -1;
    if (ib !== null) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function slotIdsSet(config) {
  return new Set(config.slots.map((slot) => slot.id));
}

function removeSlotsById(config, state, slotIdsToRemove) {
  if (!slotIdsToRemove || slotIdsToRemove.size === 0) {
    return { changed: false, removedSlots: [] };
  }
  const removedSlots = config.slots.filter((slot) => slotIdsToRemove.has(slot.id));
  const beforeLen = config.slots.length;
  config.slots = config.slots.filter((slot) => !slotIdsToRemove.has(slot.id));
  if (config.slots.length === beforeLen) {
    return { changed: false, removedSlots: [] };
  }

  for (const slotId of slotIdsToRemove) {
    if (state?.slots && slotId in state.slots) {
      delete state.slots[slotId];
    }
    if (state?.leases && slotId in state.leases) {
      delete state.leases[slotId];
    }
  }

  if (slotIdsToRemove.has(state.active_slot)) {
    state.active_slot = null;
  }
  if (slotIdsToRemove.has(config.default_slot)) {
    config.default_slot = null;
  }

  if (state?.sessions && typeof state.sessions === 'object') {
    for (const session of Object.values(state.sessions)) {
      if (!session || typeof session !== 'object') continue;
      if (slotIdsToRemove.has(session.last_slot)) session.last_slot = null;
      if (slotIdsToRemove.has(session.suggested_slot)) session.suggested_slot = null;
    }
  }
  return { changed: true, removedSlots };
}

function rebuildStateSlotsAfterRename(config, state, oldIdBySlot) {
  const oldStateSlots = state.slots && typeof state.slots === 'object'
    ? state.slots
    : {};

  const nextStateSlots = {};
  const idMap = new Map();

  for (const slot of config.slots) {
    const oldId = oldIdBySlot.get(slot) || slot.id;
    idMap.set(oldId, slot.id);
    const previous = oldStateSlots[oldId] || oldStateSlots[slot.id] || null;
    nextStateSlots[slot.id] = previous || {
      status: 'ready',
      blocked_until: null,
      last_error: null,
      last_error_at: null,
      last_ok: null
    };
  }

  state.slots = nextStateSlots;

  if (!state.leases || typeof state.leases !== 'object') {
    state.leases = {};
  } else {
    const nextLeases = {};
    for (const [oldSlotId, lease] of Object.entries(state.leases)) {
      const mappedSlotId = idMap.get(oldSlotId) || oldSlotId;
      if (slotIdsSet(config).has(mappedSlotId)) {
        nextLeases[mappedSlotId] = {
          ...lease,
          slot_id: mappedSlotId
        };
      }
    }
    state.leases = nextLeases;
  }

  if (state.active_slot) {
    state.active_slot = idMap.get(state.active_slot) || state.active_slot;
  }
  if (config.default_slot) {
    config.default_slot = idMap.get(config.default_slot) || config.default_slot;
  }

  if (state?.sessions && typeof state.sessions === 'object') {
    for (const session of Object.values(state.sessions)) {
      if (!session || typeof session !== 'object') continue;
      if (session.last_slot) {
        session.last_slot = idMap.get(session.last_slot) || session.last_slot;
      }
      if (session.suggested_slot) {
        session.suggested_slot = idMap.get(session.suggested_slot) || session.suggested_slot;
      }
    }
  }

  return idMap;
}

function ensureDefaultAndActive(config, state) {
  const beforeDefault = config.default_slot;
  const beforeActive = state.active_slot;
  const ids = slotIdsSet(config);
  if (!ids.has(config.default_slot)) {
    config.default_slot = ids.has('main') ? 'main' : (config.slots[0]?.id || null);
  }
  if (!ids.has(state.active_slot)) {
    state.active_slot = config.default_slot || config.slots[0]?.id || null;
  }

  for (const slot of config.slots) {
    ensureSlotState(state, slot.id);
  }

  return beforeDefault !== config.default_slot || beforeActive !== state.active_slot;
}

async function moveAutoSlotHomes(autoSlots, report) {
  const plans = autoSlots
    .map((slot) => {
      const from = String(slot.codex_home || '');
      const baseName = path.basename(from);
      const to = AUTO_SLOT_RE.test(baseName)
        ? path.join(path.dirname(from), slot.id)
        : from;
      return { slot, from, to };
    })
    .filter((entry) => entry.from && entry.to && entry.from !== entry.to);

  if (plans.length === 0) return false;

  let changed = false;
  const staged = [];
  const stamp = `${Date.now()}-${process.pid}`;

  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    const existsFrom = await pathExists(plan.from);
    if (!existsFrom) {
      staged.push({ ...plan, temp: null });
      continue;
    }
    const temp = `${plan.from}.rotor-move-${stamp}-${i}`;
    await fs.rename(plan.from, temp);
    staged.push({ ...plan, temp });
  }

  for (const plan of staged) {
    const currentSlot = plan.slot;
    if (!plan.temp) {
      currentSlot.codex_home = plan.to;
      report.renumbered.push({
        from_id: currentSlot.id,
        to_id: currentSlot.id,
        from_label: currentSlot.label,
        to_label: currentSlot.label,
        moved_home_to: plan.to
      });
      changed = true;
      continue;
    }

    await fs.mkdir(path.dirname(plan.to), { recursive: true, mode: 0o700 });
    if (await pathExists(plan.to)) {
      // Safety-first: never delete an existing destination path here.
      // Restore original home path and keep codex_home stable.
      if (!(await pathExists(plan.from))) {
        await fs.rename(plan.temp, plan.from);
      }
      currentSlot.codex_home = plan.from;
      if (!Array.isArray(report.move_conflicts)) {
        report.move_conflicts = [];
      }
      report.move_conflicts.push({
        slot_id: currentSlot.id,
        kept_home: plan.from,
        conflicted_target: plan.to
      });
      changed = true;
      continue;
    }

    try {
      await fs.rename(plan.temp, plan.to);
      currentSlot.codex_home = plan.to;
      report.renumbered.push({
        from_id: currentSlot.id,
        to_id: currentSlot.id,
        from_label: currentSlot.label,
        to_label: currentSlot.label,
        moved_home_to: plan.to
      });
      changed = true;
    } catch {
      // Safety-first fallback: keep original slot home on move conflict/error.
      if (!(await pathExists(plan.from))) {
        await fs.rename(plan.temp, plan.from);
      }
      currentSlot.codex_home = plan.from;
      if (!Array.isArray(report.move_conflicts)) {
        report.move_conflicts = [];
      }
      report.move_conflicts.push({
        slot_id: currentSlot.id,
        kept_home: plan.from,
        conflicted_target: plan.to
      });
      changed = true;
    }
  }

  return changed;
}

async function cleanupRemovedSlotHomes(removedSlots) {
  // Non-destructive reconcile policy:
  // slot cleanup removes only config/state entries. Home directories are preserved.
  void removedSlots;
}

export async function loadIdentitiesBySlot(config) {
  const entries = await Promise.all(
    config.slots.map(async (slot) => [slot.id, await readSlotAuthIdentity(slot.codex_home)])
  );
  return Object.fromEntries(entries);
}

export async function reconcileSlots(config, state) {
  const report = {
    removed_invalid: [],
    removed_duplicate: [],
    renumbered: [],
    move_conflicts: []
  };

  let changed = false;
  let identitiesBySlot = await loadIdentitiesBySlot(config);

  // 1) Remove invalid non-main slots (no readable auth identity)
  const invalidIds = new Set(
    config.slots
      .filter((slot) => !isMainSlot(slot) && !identitiesBySlot[slot.id] && !isPendingAuthSlot(state, slot.id))
      .map((slot) => slot.id)
  );
  if (invalidIds.size > 0) {
    report.removed_invalid = [...invalidIds];
    const removed = removeSlotsById(config, state, invalidIds);
    changed = removed.changed || changed;
    await cleanupRemovedSlotHomes(removed.removedSlots);
  }

  if (changed) {
    identitiesBySlot = await loadIdentitiesBySlot(config);
  }

  // 2) Remove duplicates by account+workspace fingerprint (keep first, prefer main)
  const seenFingerprint = new Map();
  const duplicateIds = [];
  for (const slot of sortSlotsForIdentityDedup(config.slots)) {
    const fp = identitiesBySlot[slot.id]?.fingerprint || null;
    if (!fp) continue;
    if (seenFingerprint.has(fp)) {
      duplicateIds.push({ slot_id: slot.id, kept_slot_id: seenFingerprint.get(fp), fingerprint: fp });
      continue;
    }
    seenFingerprint.set(fp, slot.id);
  }

  if (duplicateIds.length > 0) {
    report.removed_duplicate = duplicateIds;
    const duplicateIdSet = new Set(duplicateIds.map((entry) => entry.slot_id));
    const removed = removeSlotsById(config, state, duplicateIdSet);
    changed = removed.changed || changed;
    await cleanupRemovedSlotHomes(removed.removedSlots);
    identitiesBySlot = await loadIdentitiesBySlot(config);
  }

  // 3) Renumber auto slots sequentially and normalize labels/priorities
  const autoSlots = sortAutoSlots(config.slots.filter((slot) => !isMainSlot(slot) && AUTO_SLOT_RE.test(slot.id)));
  const oldIdBySlot = new Map(config.slots.map((slot) => [slot, slot.id]));

  autoSlots.forEach((slot, idx) => {
    const targetId = `slot-${idx + 1}`;
    const targetLabel = `Account ${idx + 1}`;
    const targetPriority = 99 - idx;

    const before = {
      id: slot.id,
      label: slot.label,
      priority: slot.priority
    };

    if (slot.id !== targetId) {
      slot.id = targetId;
      changed = true;
    }
    if (slot.label !== targetLabel) {
      slot.label = targetLabel;
      changed = true;
    }
    if (Number(slot.priority) !== targetPriority) {
      slot.priority = targetPriority;
      changed = true;
    }

    if (before.id !== slot.id || before.label !== slot.label || before.priority !== slot.priority) {
      report.renumbered.push({
        from_id: before.id,
        to_id: slot.id,
        from_label: before.label,
        to_label: slot.label
      });
    }
  });

  changed = await moveAutoSlotHomes(autoSlots, report) || changed;

  if (changed) {
    rebuildStateSlotsAfterRename(config, state, oldIdBySlot);

    // Keep deterministic ordering: main first, then auto slots by id, then remaining custom slots by id.
    const mainSlots = config.slots.filter((slot) => isMainSlot(slot));
    const managedAutoSlots = sortAutoSlots(config.slots.filter((slot) => !isMainSlot(slot) && AUTO_SLOT_RE.test(slot.id)));
    const customSlots = [...config.slots]
      .filter((slot) => !isMainSlot(slot) && !AUTO_SLOT_RE.test(slot.id))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    if (mainSlots[0]) {
      mainSlots[0].priority = 100;
    }
    config.slots = [...mainSlots, ...managedAutoSlots, ...customSlots];
    changed = ensureDefaultAndActive(config, state) || changed;
    identitiesBySlot = await loadIdentitiesBySlot(config);
  } else {
    changed = ensureDefaultAndActive(config, state) || changed;
  }

  return {
    changed,
    identitiesBySlot,
    report
  };
}
