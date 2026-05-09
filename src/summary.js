/**
 * Rolling session summary — session compaction layer.
 * Generates compressed summaries of past sessions and injects them on chat load.
 * Scoped per persona + world + character.
 */

import { generateRaw } from '../../../../../script.js';
import { getSummaries, appendSummary, getSharedSummaries, appendSharedSummary } from './api.js';

export const DEFAULT_SUMMARY_PROMPT =
    'You are a narrator writing a concise summary of what happened in this roleplay session. ' +
    'Focus on key events, decisions, and changes to the character\'s situation. ' +
    'Keep it under {{words}} words. Write in past tense, third person. ' +
    'Do not include meta-commentary about the roleplay format itself.';

/**
 * Generate a new session summary using the main LLM.
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} characterName
 * @param {Array}  chatMessages       {name, mes, is_user}[]
 * @param {string} chatId
 * @param {string} promptTemplate     May contain {{words}} placeholder
 * @param {number} targetWords
 * @returns {Promise<string|null>}
 */
export async function generateSessionSummary(avatarId, worldTag, characterName, chatMessages, chatId, promptTemplate = DEFAULT_SUMMARY_PROMPT, targetWords = 200) {
    if (!chatMessages?.length) return null;

    const systemPrompt = promptTemplate.replace('{{words}}', String(targetWords));

    const transcript = chatMessages
        .slice(-60)
        .filter(m => m.mes && m.mes.trim().length > 5)
        .map(m => `${m.name}: ${m.mes.trim()}`)
        .join('\n');

    if (!transcript) return null;

    try {
        const summary = await generateRaw({
            prompt: transcript,
            systemPrompt,
            responseLength: 10000,
        });

        if (!summary) return null;

        await appendSummary(avatarId, worldTag, characterName, {
            chatId,
            summary,
            messageCount: chatMessages.length,
        });

        return summary;
    } catch (err) {
        console.error('[PAC] Summary generation failed:', err);
        return null;
    }
}

/**
 * Generate a session summary and save it to the shared world pool (persistentWorld = ON).
 * @param {string} worldTag
 * @param {string} characterName
 * @param {Array}  chatMessages
 * @param {string} chatId
 * @param {string} promptTemplate
 * @param {number} targetWords
 * @returns {Promise<string|null>}
 */
export async function generateSharedSessionSummary(worldTag, characterName, chatMessages, chatId, promptTemplate = DEFAULT_SUMMARY_PROMPT, targetWords = 200) {
    if (!chatMessages?.length) return null;

    const systemPrompt = promptTemplate.replace('{{words}}', String(targetWords));
    const transcript = chatMessages
        .slice(-60)
        .filter(m => m.mes && m.mes.trim().length > 5)
        .map(m => `${m.name}: ${m.mes.trim()}`)
        .join('\n');

    if (!transcript) return null;

    try {
        const summary = await generateRaw({
            prompt: transcript,
            systemPrompt,
            responseLength: 10000,
        });

        if (!summary) return null;

        await appendSharedSummary(worldTag, characterName, {
            chatId,
            summary,
            messageCount: chatMessages.length,
        });

        return summary;
    } catch (err) {
        console.error('[PAC] Shared summary generation failed:', err);
        return null;
    }
}

/**
 * Load the most recent summaries from the shared world pool.
 * @param {string} worldTag
 * @param {string} characterName
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function loadSharedSummaries(worldTag, characterName, limit = 3) {
    try {
        return await getSharedSummaries(worldTag, characterName, { limit });
    } catch (err) {
        console.warn('[PAC] Could not load shared summaries:', err);
        return [];
    }
}

/**
 * Load the most recent session summaries for a character.
 * @param {string} avatarId
 * @param {string} worldTag
 * @param {string} characterName
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function loadSummaries(avatarId, worldTag, characterName, limit = 3) {
    try {
        return await getSummaries(avatarId, worldTag, characterName, { limit });
    } catch (err) {
        console.warn('[PAC] Could not load summaries:', err);
        return [];
    }
}

/**
 * Format summaries for prompt injection.
 * @param {Array}  summaries
 * @param {number} maxSummaries
 * @returns {string}
 */
export function formatSummaries(summaries, maxSummaries = 2) {
    if (!summaries?.length) return '';
    const slice = summaries.slice(-maxSummaries);
    const parts = slice.map((s, i) => {
        const label = slice.length > 1 ? `Story So Far (${i + 1} of ${slice.length})` : 'Story So Far';
        return `[${label}]\n${s.summary}`;
    });
    return parts.join('\n\n');
}
