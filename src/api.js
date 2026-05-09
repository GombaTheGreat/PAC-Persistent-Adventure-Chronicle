/**
 * Fetch wrappers for the PAC server plugin API.
 * All routes live under /api/plugins/pac/personas/{avatarId}/...
 *
 * All character-level functions now require a worldTag — memory is scoped to
 * the active world (detected from character card tags). The extension is
 * inactive when no world tag is matched.
 */

import { getRequestHeaders } from '../../../../../script.js';

const BASE = '/api/plugins/pac';

async function apiFetch(path, options = {}) {
    const response = await fetch(`${BASE}${path}`, {
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        ...options,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const summary = text.length > 200 ? text.slice(0, 200) + '…' : text;
        throw new Error(`PAC API error ${response.status}: ${summary}`);
    }
    return response.json();
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/** Lightweight plugin liveness check — resolves {ok:true} or throws. */
export const healthCheck = () =>
    apiFetch('/health');

export const listPersonas = () =>
    apiFetch('/personas');

export const deletePersonaData = (avatarId) =>
    apiFetch(`/personas/${enc(avatarId)}`, { method: 'DELETE' });

export const exportPersona = (avatarId) =>
    apiFetch(`/personas/${enc(avatarId)}/export`);

export const importPersona = (avatarId, bundle, overwrite = false) =>
    apiFetch(`/personas/${enc(avatarId)}/import${overwrite ? '?mode=overwrite' : ''}`, {
        method: 'POST',
        body: JSON.stringify(bundle),
    });

// ---------------------------------------------------------------------------
// World browser
// ---------------------------------------------------------------------------

/** Returns array of { tag, hasWorldIdentity, characters: [{name, eventCount, summaryCount}] } */
export const getWorldList = (avatarId) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds`);

export const deleteWorld = (avatarId, worldTag) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}`, { method: 'DELETE' });

export const deleteCharData = (avatarId, worldTag, charName) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Identity — world-level (persona silo, persistentWorld = OFF)
// ---------------------------------------------------------------------------

export const getWorldIdentity = (avatarId, worldTag) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/identity`);

export const saveWorldIdentity = (avatarId, worldTag, data) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/identity`, {
        method: 'POST',
        body: JSON.stringify(data),
    });

// ---------------------------------------------------------------------------
// Identity — character-level (persona silo, persistentWorld = OFF)
// ---------------------------------------------------------------------------

export const getCharIdentity = (avatarId, worldTag, charName) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/identity`);

export const saveCharIdentity = (avatarId, worldTag, charName, data) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/identity`, {
        method: 'POST',
        body: JSON.stringify(data),
    });

// ---------------------------------------------------------------------------
// Character events (world-scoped)
// ---------------------------------------------------------------------------

export const getEvents = (avatarId, worldTag, charName, { offset = 0, limit = 200 } = {}) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events?offset=${offset}&limit=${limit}`);

export const appendEvent = (avatarId, worldTag, charName, record) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events`, {
        method: 'POST',
        body: JSON.stringify(record),
    });

export const deleteEvent = (avatarId, worldTag, charName, index) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/${index}`, { method: 'DELETE' });

export const clearEvents = (avatarId, worldTag, charName) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events`, { method: 'DELETE' });

export const bulkDeleteEvents = (avatarId, worldTag, charName, indices) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ indices }),
    });

/** BM25 semantic search over the character's event log (server-side, no external deps). */
export const searchEvents = (avatarId, worldTag, charName, query, topK = 5) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/search`, {
        method: 'POST',
        body: JSON.stringify({ query, topK }),
    });

// ---------------------------------------------------------------------------
// Character summaries (world-scoped)
// ---------------------------------------------------------------------------

export const getSummaries = (avatarId, worldTag, charName, { limit = 5 } = {}) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries?limit=${limit}`);

export const appendSummary = (avatarId, worldTag, charName, record) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries`, {
        method: 'POST',
        body: JSON.stringify(record),
    });

export const deleteSummary = (avatarId, worldTag, charName, index) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries/${index}`, { method: 'DELETE' });

export const clearSummaries = (avatarId, worldTag, charName) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries`, { method: 'DELETE' });

export const updateSummary = (avatarId, worldTag, charName, index, summaryText) =>
    apiFetch(`/personas/${enc(avatarId)}/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries/${index}`, {
        method: 'PATCH',
        body: JSON.stringify({ summary: summaryText }),
    });

// ---------------------------------------------------------------------------
// Shared world pool (persistentWorld = ON)
// No avatarId in path — data is accessible to all personas.
// ---------------------------------------------------------------------------

export const getSharedWorldIdentity = (worldTag) =>
    apiFetch(`/worlds/${enc(worldTag)}/identity`);

export const saveSharedWorldIdentity = (worldTag, data) =>
    apiFetch(`/worlds/${enc(worldTag)}/identity`, { method: 'POST', body: JSON.stringify(data) });

export const getSharedCharIdentity = (worldTag, charName) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/identity`);

export const saveSharedCharIdentity = (worldTag, charName, data) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/identity`, {
        method: 'POST',
        body: JSON.stringify(data),
    });

export const getSharedEvents = (worldTag, charName, { offset = 0, limit = 200 } = {}) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events?offset=${offset}&limit=${limit}`);

export const appendSharedEvent = (worldTag, charName, record) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events`, {
        method: 'POST',
        body: JSON.stringify(record),
    });

export const searchSharedEvents = (worldTag, charName, query, topK = 5) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/search`, {
        method: 'POST',
        body: JSON.stringify({ query, topK }),
    });

export const getSharedSummaries = (worldTag, charName, { limit = 5 } = {}) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries?limit=${limit}`);

export const appendSharedSummary = (worldTag, charName, record) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries`, {
        method: 'POST',
        body: JSON.stringify(record),
    });

export const bulkDeleteSharedEvents = (worldTag, charName, indices) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ indices }),
    });

export const deleteSharedEvent = (worldTag, charName, index) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events/${index}`, { method: 'DELETE' });

export const clearSharedEvents = (worldTag, charName) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/events`, { method: 'DELETE' });

export const deleteSharedSummary = (worldTag, charName, index) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries/${index}`, { method: 'DELETE' });

export const clearSharedSummaries = (worldTag, charName) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries`, { method: 'DELETE' });

export const updateSharedSummary = (worldTag, charName, index, summaryText) =>
    apiFetch(`/worlds/${enc(worldTag)}/characters/${enc(charName)}/summaries/${index}`, {
        method: 'PATCH',
        body: JSON.stringify({ summary: summaryText }),
    });
