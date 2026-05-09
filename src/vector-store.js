/**
 * Vector store — client-side wrapper around SillyTavern's built-in /api/vector/* endpoints.
 *
 * ST's vector API is always registered unconditionally (server-startup.js line 168).
 * Default source 'transformers' auto-downloads Xenova/all-mpnet-base-v2 (384-dim, CPU-compatible)
 * on first use — no user configuration required.
 *
 * All functions are designed to fail silently: callers should .catch(() => {}) on
 * fire-and-forget operations so a missing/cold model never breaks the main flow.
 */

import { getRequestHeaders } from '../../../../../script.js';

const VECTOR_API = '/api/vector';
const SOURCE = 'transformers'; // uses Xenova/all-mpnet-base-v2, auto-downloads

/**
 * Derive a safe vector collection ID from persona + world + character.
 * Characters replaced to keep the ID filesystem-safe.
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 * @returns {string}
 */
function collectionId(avatarId, worldTag, charName) {
    const safe = (s) => String(s).replace(/[^a-zA-Z0-9-]/g, '_');
    return `ms__${safe(avatarId)}__${safe(worldTag)}__${safe(charName)}`;
}

/**
 * Stable text-based hash — used as the item identifier in the vector index.
 * Text-derived so inserts are idempotent: re-indexing the same event is safe.
 * @param {string} s
 * @returns {string}
 */
function textHash(s) {
    let h = 0;
    for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
    return Math.abs(h).toString(16).padStart(8, '0');
}

/**
 * Index a single event text into the character's vector collection.
 * Designed to be called fire-and-forget after logEvent.
 *
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 * @param {string} eventText
 * @returns {Promise<void>}
 */
export async function indexEvent(avatarId, worldTag, charName, eventText) {
    const resp = await fetch(`${VECTOR_API}/insert`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId: collectionId(avatarId, worldTag, charName),
            items: [{ hash: textHash(eventText), text: eventText, index: 0 }],
            source: SOURCE,
        }),
    });
    if (!resp.ok) throw new Error(`Vector insert HTTP ${resp.status}`);
}

/**
 * Semantic search — returns top-K events most similar to queryText.
 * Returns an array of { event, ts } objects (ts is always 0 since the hash is text-derived;
 * injector.js uses event text as the deduplication key in the RRF merge).
 *
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 * @param {string} queryText
 * @param {number} topK
 * @returns {Promise<Array<{event: string, ts: number}>>}
 */
export async function queryEvents(avatarId, worldTag, charName, queryText, topK = 10) {
    const resp = await fetch(`${VECTOR_API}/query`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId: collectionId(avatarId, worldTag, charName),
            searchText: queryText,
            topK,
            source: SOURCE,
        }),
    });
    if (!resp.ok) throw new Error(`Vector query HTTP ${resp.status}`);
    const data = await resp.json();
    const metadata = data.metadata || [];
    return metadata.map(m => ({ event: m.text || '', ts: 0 })).filter(m => m.event);
}

/**
 * Bulk-index an array of events (migration / user-triggered rebuild).
 * Uses a single batch insert for efficiency.
 *
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 * @param {Array<{event: string}>} events
 * @returns {Promise<void>}
 */
export async function rebuildEventIndex(avatarId, worldTag, charName, events) {
    if (!events?.length) return;
    const items = events
        .filter(e => e?.event)
        .map(e => ({ hash: textHash(e.event), text: e.event, index: 0 }));
    if (!items.length) return;

    const resp = await fetch(`${VECTOR_API}/insert`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId: collectionId(avatarId, worldTag, charName),
            items,
            source: SOURCE,
        }),
    });
    if (!resp.ok) throw new Error(`Vector bulk insert HTTP ${resp.status}`);
}

/**
 * Purge all vectors for a character (called when events are cleared).
 *
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} charName
 * @returns {Promise<void>}
 */
export async function purgeEventVectors(avatarId, worldTag, charName) {
    const resp = await fetch(`${VECTOR_API}/purge`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId: collectionId(avatarId, worldTag, charName),
            source: SOURCE,
        }),
    });
    if (!resp.ok) throw new Error(`Vector purge HTTP ${resp.status}`);
}
