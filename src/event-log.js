/**
 * Event log — episodic memory layer.
 * Appends and reads timestamped plot events per character, scoped per persona + world.
 */

import { getEvents, appendEvent, getSharedEvents, appendSharedEvent } from './api.js';
import { indexEvent } from './vector-store.js';

/**
 * Append a new event to the character's event log and fire-and-forget index it
 * into the vector store for semantic search.
 * @param {string}   avatarId
 * @param {string}   worldTag
 * @param {string}   characterName
 * @param {string}   eventText
 * @param {string[]} tags
 * @param {string}   chatId
 */
export async function logEvent(avatarId, worldTag, characterName, eventText, tags = [], chatId = '') {
    try {
        await appendEvent(avatarId, worldTag, characterName, { event: eventText, tags, chatId });
        // Non-blocking: index for semantic search.
        // Fails silently — a cold/unavailable model must never break the write path.
        indexEvent(avatarId, worldTag, characterName, eventText).catch(err => {
            console.debug('[PAC] Vector index skipped (non-critical):', err?.message);
        });
    } catch (err) {
        console.error('[PAC] Could not log event:', err);
    }
}

/**
 * Read events from the character's log.
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} characterName
 * @param {object} options
 * @returns {Promise<Array>}
 */
export async function readEvents(avatarId, worldTag, characterName, { offset = 0, limit = 200 } = {}) {
    try {
        return await getEvents(avatarId, worldTag, characterName, { offset, limit });
    } catch (err) {
        console.warn('[PAC] Could not read events:', err);
        return [];
    }
}

/**
 * Append an event to the shared world pool (persistentWorld = ON).
 * @param {string}   worldTag
 * @param {string}   characterName
 * @param {string}   eventText
 * @param {string[]} tags
 * @param {string}   chatId
 */
export async function logSharedEvent(worldTag, characterName, eventText, tags = [], chatId = '') {
    try {
        await appendSharedEvent(worldTag, characterName, { event: eventText, tags, chatId });
    } catch (err) {
        console.error('[PAC] Could not log shared event:', err);
    }
}

/**
 * Read events from the shared world pool.
 * @param {string} worldTag
 * @param {string} characterName
 * @param {object} options
 * @returns {Promise<Array>}
 */
export async function readSharedEvents(worldTag, characterName, { offset = 0, limit = 200 } = {}) {
    try {
        return await getSharedEvents(worldTag, characterName, { offset, limit });
    } catch (err) {
        console.warn('[PAC] Could not read shared events:', err);
        return [];
    }
}

/**
 * Format a list of events as a compact string for prompt injection.
 * @param {Array}  events
 * @param {number} maxEvents
 * @returns {string}
 */
export function formatEvents(events, maxEvents = 8) {
    if (!events?.length) return '';
    const slice = events.slice(-maxEvents);
    const lines = slice.map(e => `• ${e.event}`);
    return `[Memories]\n${lines.join('\n')}`;
}
