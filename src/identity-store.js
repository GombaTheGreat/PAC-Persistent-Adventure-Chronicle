/**
 * Identity store — Layer 1 (durable truths).
 *
 * Tracks what has CHANGED from the lorebook baseline:
 *   - Persona standing: titles earned, faction standing, reputation, NPC relationships
 *   - World facts: permanent world-shaping changes (world-scoped, not persona-scoped)
 *   - Character identity: permanent facts about the AI character card
 *
 * Scoped per persona + world (persistentWorld=OFF) or shared world pool (persistentWorld=ON).
 * Your Profile is always persona-scoped. Character Knowledge, World State, Memories,
 * and Story So Far are shared when persistentWorld=ON.
 *
 * Cache keys (persona-scoped):
 *   persona world-level  : `${avatarId}:world:${worldTag}`
 *   persona char-level   : `${avatarId}:char:${worldTag}:${charName}`
 *
 * Cache keys (shared pool, sharedCache):
 *   world state          : `ws:${worldTag}`
 *   character knowledge  : `ck:${worldTag}:${charName}`
 */

import { getWorldIdentity, saveWorldIdentity, getCharIdentity, saveCharIdentity,
    getSharedWorldIdentity, saveSharedWorldIdentity, getSharedCharIdentity, saveSharedCharIdentity } from './api.js';

/** In-memory cache. Key: see above. */
const cache = new Map();

/** Synthetic avatarId for character-scoped identity — not tied to any persona. */
const CHAR_AVATAR = '_char';

/** Synthetic avatarId for world-level facts — shared across all personas. */
const WORLD_AVATAR = '_world';

/** Empty identity structure. */
export function emptyIdentity() {
    return {
        titles: [],
        factions: [],       // [{ name, stance }]
        reputation: {},     // { locationOrGroup: descriptor }
        relationships: [],  // [{ name, type }]
        custom: {},
        worldFacts: [],     // [{ fact, ts, chatId }]
    };
}

function worldKey(avatarId, worldTag) {
    return `${avatarId}:world:${worldTag}`;
}

function charKey(avatarId, worldTag, charName) {
    return `${avatarId}:char:${worldTag}:${charName}`;
}

/**
 * Load identity from cache or server.
 *
 * @param {string}      avatarId
 * @param {string}      worldTag
 * @param {string|null} charName  Null for Your Profile; provide charName for Character Knowledge (persistentWorld=OFF)
 * @returns {Promise<object>}
 */
export async function loadIdentity(avatarId, worldTag, charName = null) {
    const key = charName ? charKey(avatarId, worldTag, charName) : worldKey(avatarId, worldTag);
    if (cache.has(key)) return cache.get(key);

    try {
        const data = charName
            ? await getCharIdentity(avatarId, worldTag, charName)
            : await getWorldIdentity(avatarId, worldTag);
        const identity = Object.keys(data).length ? data : emptyIdentity();
        const merged = { ...emptyIdentity(), ...identity };
        cache.set(key, merged);
        return merged;
    } catch (err) {
        console.warn('[PAC] Could not load identity:', err);
        return emptyIdentity();
    }
}

/**
 * Save identity to cache and server.
 *
 * @param {string}      avatarId
 * @param {string}      worldTag
 * @param {object}      identity
 * @param {string|null} charName  Null for Your Profile; provide charName for Character Knowledge (persistentWorld=OFF)
 */
export async function storeIdentity(avatarId, worldTag, identity, charName = null) {
    const key = charName ? charKey(avatarId, worldTag, charName) : worldKey(avatarId, worldTag);
    const previous = cache.get(key);
    cache.set(key, identity);
    try {
        if (charName) {
            await saveCharIdentity(avatarId, worldTag, charName, identity);
        } else {
            await saveWorldIdentity(avatarId, worldTag, identity);
        }
    } catch (err) {
        // Revert cache so it stays consistent with the server
        if (previous !== undefined) {
            cache.set(key, previous);
        } else {
            cache.delete(key);
        }
        console.error('[PAC] Could not save identity:', err);
        throw err;
    }
}

/**
 * Invalidate all cached identity entries for a persona.
 * @param {string} avatarId
 */
export function invalidateIdentityCache(avatarId) {
    for (const key of cache.keys()) {
        if (key.startsWith(avatarId + ':')) cache.delete(key);
    }
}

/**
 * Invalidate the cache for a single character (persona-scoped + shared pool).
 * Used in group chats to force a fresh fetch for the responding character each turn,
 * preventing stale Layer 1 data from persisting across the session.
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 */
export function invalidateCharacterCacheEntry(avatarId, worldTag, charName) {
    cache.delete(charKey(avatarId, worldTag, charName));
    sharedCache.delete(`ck:${worldTag}:${charName}`);
}

// ---------------------------------------------------------------------------
// Character identity — scoped to worldTag + charName (no persona dependency)
// ---------------------------------------------------------------------------

/**
 * Load character-scoped identity (not tied to any persona).
 * @param {string} worldTag
 * @param {string} charName
 * @returns {Promise<object>}
 */
export async function loadCharacterIdentity(worldTag, charName) {
    return loadIdentity(CHAR_AVATAR, worldTag, charName);
}

/**
 * Save character-scoped identity.
 * @param {string} worldTag
 * @param {string} charName
 * @param {object} identity
 */
export async function storeCharacterIdentity(worldTag, charName, identity) {
    return storeIdentity(CHAR_AVATAR, worldTag, identity, charName);
}

// ---------------------------------------------------------------------------
// World facts — scoped to worldTag only (shared across all personas)
// ---------------------------------------------------------------------------

/**
 * Load world-level identity (holds world facts, shared across all personas).
 * @param {string} worldTag
 * @returns {Promise<object>}
 */
export async function loadWorldIdentity(worldTag) {
    return loadIdentity(WORLD_AVATAR, worldTag, null);
}

/**
 * Append world facts to the world-level identity store.
 * @param {string}   worldTag
 * @param {string[]} worldFactStrs
 * @param {string}   chatId
 */
export async function applyWorldFacts(worldTag, worldFactStrs, chatId) {
    if (!worldFactStrs?.length) return;
    const identity = await loadWorldIdentity(worldTag);
    applyIdentityExtraction(identity, {}, worldFactStrs, chatId);
    await storeIdentity(WORLD_AVATAR, worldTag, identity, null);
}

// ---------------------------------------------------------------------------
// Shared world pool (persistentWorld = ON)
// No persona dependency — accessible to all personas in the world.
// ---------------------------------------------------------------------------

/** Separate cache for shared world pool entries to avoid namespace collisions. */
const sharedCache = new Map();

/**
 * Load world state from the shared world pool.
 * @param {string} worldTag
 * @returns {Promise<object>}
 */
export async function loadSharedWorldState(worldTag) {
    const key = `ws:${worldTag}`;
    if (sharedCache.has(key)) return sharedCache.get(key);
    try {
        const data = await getSharedWorldIdentity(worldTag);
        const identity = Object.keys(data).length ? data : emptyIdentity();
        const merged = { ...emptyIdentity(), ...identity };
        sharedCache.set(key, merged);
        return merged;
    } catch (err) {
        console.warn('[PAC] Could not load shared world state:', err);
        return emptyIdentity();
    }
}

/**
 * Save world state to the shared world pool.
 * @param {string} worldTag
 * @param {object} identity
 */
export async function storeSharedWorldState(worldTag, identity) {
    const key = `ws:${worldTag}`;
    const previous = sharedCache.get(key);
    sharedCache.set(key, identity);
    try {
        await saveSharedWorldIdentity(worldTag, identity);
    } catch (err) {
        if (previous !== undefined) sharedCache.set(key, previous);
        else sharedCache.delete(key);
        console.error('[PAC] Could not save shared world state:', err);
        throw err;
    }
}

/**
 * Append world facts to the shared world pool.
 * @param {string}   worldTag
 * @param {string[]} worldFactStrs
 * @param {string}   chatId
 */
export async function applySharedWorldFacts(worldTag, worldFactStrs, chatId) {
    if (!worldFactStrs?.length) return;
    const identity = await loadSharedWorldState(worldTag);
    applyIdentityExtraction(identity, {}, worldFactStrs, chatId);
    await storeSharedWorldState(worldTag, identity);
}

/**
 * Load character knowledge from the shared world pool.
 * @param {string} worldTag
 * @param {string} charName
 * @returns {Promise<object>}
 */
export async function loadSharedCharKnowledge(worldTag, charName) {
    const key = `ck:${worldTag}:${charName}`;
    if (sharedCache.has(key)) return sharedCache.get(key);
    try {
        const data = await getSharedCharIdentity(worldTag, charName);
        const identity = Object.keys(data).length ? data : emptyIdentity();
        const merged = { ...emptyIdentity(), ...identity };
        sharedCache.set(key, merged);
        return merged;
    } catch (err) {
        console.warn('[PAC] Could not load shared char knowledge:', err);
        return emptyIdentity();
    }
}

/**
 * Save character knowledge to the shared world pool.
 * @param {string} worldTag
 * @param {string} charName
 * @param {object} identity
 */
export async function storeSharedCharKnowledge(worldTag, charName, identity) {
    const key = `ck:${worldTag}:${charName}`;
    const previous = sharedCache.get(key);
    sharedCache.set(key, identity);
    try {
        await saveSharedCharIdentity(worldTag, charName, identity);
    } catch (err) {
        if (previous !== undefined) sharedCache.set(key, previous);
        else sharedCache.delete(key);
        console.error('[PAC] Could not save shared char knowledge:', err);
        throw err;
    }
}

/**
 * Invalidate shared cache entries for a specific world.
 * @param {string} worldTag
 */
export function invalidateSharedCache(worldTag) {
    for (const key of sharedCache.keys()) {
        if (key.includes(`:${worldTag}`)) sharedCache.delete(key);
    }
}

/**
 * Apply extraction results to the identity object (mutates in place).
 *
 * @param {object}   identity
 * @param {object}   personaFacts    personaFacts bucket from extraction
 * @param {string[]} worldFactStrs   worldFacts bucket from extraction (plain strings)
 * @param {string}   chatId
 */
export function applyIdentityExtraction(identity, personaFacts = {}, worldFactStrs = [], chatId = '') {
    const now = Date.now();

    // --- Titles ---
    for (const change of (personaFacts.titles || [])) {
        if (change.action === 'add') {
            if (!identity.titles.includes(change.title)) identity.titles.push(change.title);
        } else if (change.action === 'remove') {
            identity.titles = identity.titles.filter(t => t !== change.title);
        }
    }

    // --- Factions (upsert by name) ---
    for (const f of (personaFacts.factions || [])) {
        if (!f?.name) continue;
        const existing = identity.factions.find(x => x.name === f.name);
        if (existing) {
            existing.stance = f.stance;
        } else {
            identity.factions.push({ name: f.name, stance: f.stance || 'neutral' });
        }
    }

    // --- Reputation (merge) ---
    if (personaFacts.reputation && typeof personaFacts.reputation === 'object') {
        Object.assign(identity.reputation, personaFacts.reputation);
    }

    // --- Relationships (upsert by name) ---
    for (const r of (personaFacts.relationships || [])) {
        if (!r?.name) continue;
        const existing = identity.relationships.find(x => x.name === r.name);
        if (existing) {
            existing.type = r.type;
        } else {
            identity.relationships.push({ name: r.name, type: r.type || '' });
        }
    }

    // --- Custom fields (merge) ---
    if (personaFacts.custom && typeof personaFacts.custom === 'object') {
        Object.assign(identity.custom, personaFacts.custom);
    }

    // --- World facts (append, deduplicate by text) ---
    const existingFacts = new Set(identity.worldFacts.map(w => w.fact?.toLowerCase?.() ?? ''));
    for (const fact of worldFactStrs) {
        if (fact && !existingFacts.has(fact.toLowerCase())) {
            identity.worldFacts.push({ fact, ts: now, chatId });
            existingFacts.add(fact.toLowerCase());
        }
    }
}

/**
 * Format identity for prompt injection.
 * Returns empty string if there is no meaningful content.
 *
 * @param {object} identity
 * @returns {string}
 */
export function formatIdentity(identity) {
    if (!identity) return '';

    const standing = [];

    if (identity.titles?.length) {
        standing.push(`Titles: ${identity.titles.join(', ')}`);
    }

    if (identity.factions?.length) {
        const facStr = identity.factions.map(f => `${f.name} (${f.stance || 'neutral'})`).join(', ');
        standing.push(`Factions: ${facStr}`);
    }

    if (identity.reputation && Object.keys(identity.reputation).length) {
        const repStr = Object.entries(identity.reputation)
            .map(([place, desc]) => `${desc} in ${place}`)
            .join(', ');
        standing.push(`Reputation: ${repStr}`);
    }

    if (identity.relationships?.length) {
        const relStr = identity.relationships
            .map(r => r.type ? `${r.name} (${r.type})` : r.name)
            .join(', ');
        standing.push(`Relationships: ${relStr}`);
    }

    if (identity.custom && Object.keys(identity.custom).length) {
        for (const [k, v] of Object.entries(identity.custom)) {
            standing.push(`${k}: ${v}`);
        }
    }

    const worldLines = (identity.worldFacts || []).map(w => `• ${w.fact}`);

    if (!standing.length && !worldLines.length) return '';

    const parts = [];
    if (standing.length) parts.push(`[Your Profile]\n${standing.join('\n')}`);
    if (worldLines.length) parts.push(`[World State]\n${worldLines.join('\n')}`);

    return parts.join('\n\n');
}

/**
 * Format character identity for prompt injection.
 * Header: `[CharName — Character Knowledge]`. No worldFacts, no custom fields.
 * Returns empty string if there is no meaningful content.
 *
 * @param {object} identity
 * @param {string} charName
 * @returns {string}
 */
export function formatCharacterIdentity(identity, charName) {
    if (!identity || !charName) return '';

    const lines = [];

    if (identity.titles?.length) {
        lines.push(`Titles: ${identity.titles.join(', ')}`);
    }

    if (identity.factions?.length) {
        const facStr = identity.factions.map(f => `${f.name} (${f.stance || 'neutral'})`).join(', ');
        lines.push(`Factions: ${facStr}`);
    }

    if (identity.reputation && Object.keys(identity.reputation).length) {
        const repStr = Object.entries(identity.reputation)
            .map(([place, desc]) => `${desc} in ${place}`)
            .join(', ');
        lines.push(`Reputation: ${repStr}`);
    }

    if (identity.relationships?.length) {
        const relStr = identity.relationships
            .map(r => r.type ? `${r.name} (${r.type})` : r.name)
            .join(', ');
        lines.push(`Relationships: ${relStr}`);
    }

    if (!lines.length) return '';
    return `[${charName} — Character Knowledge]\n${lines.join('\n')}`;
}
