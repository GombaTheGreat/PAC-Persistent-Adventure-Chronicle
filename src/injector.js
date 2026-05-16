/**
 * Injection engine — assembles memory context and injects it into the chat history via 4 slots.
 * Fires on GENERATE_BEFORE_COMBINE_PROMPTS.
 *
 * Prompt slots — all injected as IN_CHAT depth=1 (right before the current message):
 *   KEY_IDENTITY      depth 1  role=SYSTEM     [Your Profile] + [World State]
 *   KEY_CHAR_IDENTITY depth 1  role=SYSTEM     [CharName — Character Knowledge]
 *   KEY_SUMMARY       depth 1  role=SYSTEM     Story So Far
 *   KEY_EVENTS        depth 1  role=ASSISTANT  Memories — fills remaining budget (RAG-retrieved)
 *
 * The return value exposes 5 named sub-components for UI display purposes:
 *   profileText / worldStateText — the two sections within KEY_IDENTITY
 *   charText                     — KEY_CHAR_IDENTITY
 *   layer2Text / layer3Text      — KEY_SUMMARY / KEY_EVENTS
 */

import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { loadIdentity, formatIdentity, loadSharedWorldState, loadSharedCharKnowledge, formatCharacterIdentity } from './identity-store.js';
import { readEvents, formatEvents, readSharedEvents } from './event-log.js';
import { loadSummaries, formatSummaries, loadSharedSummaries } from './summary.js';
import { searchEvents, searchSharedEvents } from './api.js';
import { queryEvents as queryVectorEvents } from './vector-store.js';

const KEY_IDENTITY      = 'pac_identity';
const KEY_CHAR_IDENTITY = 'pac_char_identity';
const KEY_SUMMARY       = 'pac_summary';
const KEY_EVENTS        = 'pac_events';

const IN_CHAT    = extension_prompt_types.IN_CHAT;
const SYSTEM     = extension_prompt_roles.SYSTEM;
const ASSISTANT  = extension_prompt_roles.ASSISTANT;

/** Rough token estimator — accurate enough for budget purposes (1 token ≈ 4 chars). */
const est = (text) => Math.ceil(text.length / 4);

/**
 * Reciprocal Rank Fusion — merges BM25 and vector search result lists.
 * Uses event text as the deduplication key so ts=0 from vector results doesn't collide.
 * BM25 entries (which carry real timestamps) are preferred when the same event appears in both.
 *
 * Formula: score(event) = Σ 1 / (k + rank_i + 1)   where k = 60
 *
 * @param {Array<{event:string,ts:number}>} bm25Res
 * @param {Array<{event:string,ts:number}>} vecRes
 * @param {number} k  RRF constant (default 60)
 * @returns {Array<{event:string,ts:number}>}
 */
function rrfMerge(bm25Res = [], vecRes = [], k = 60) {
    const scores = new Map();
    const best   = new Map();

    const normKey = (s) => (s || '').trim().toLowerCase();

    const bm25Array = Array.isArray(bm25Res) ? bm25Res : [];
    const vecArray  = Array.isArray(vecRes)  ? vecRes  : [];

    bm25Array.forEach((r, i) => {
        const key = normKey(r.event);
        scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
        best.set(key, r);
    });
    vecArray.forEach((r, i) => {
        const key = normKey(r.event);
        scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
        if (!best.has(key)) best.set(key, r);
    });

    return [...scores.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([key]) => best.get(key))
        .filter(Boolean);
}

/**
 * Main injection function — called on GENERATE_BEFORE_COMBINE_PROMPTS.
 *
 * @param {object}  context          getContext() result
 * @param {string}  avatarId         Active persona avatar ID
 * @param {string}  worldTag         Active world tag (detected from character card tags)
 * @param {boolean} persistentWorld  When true, read from shared world pool instead of persona silo
 * @param {string}  [overrideCharName]
 * @returns {Promise<{profileText,profileTokens,worldStateText,worldStateTokens,charText,charTokens,layer1,layer2,layer3,layer1Text,layer2Text,layer3Text,used,budget}|null>}
 */
export async function buildAndInjectContext(context, avatarId, worldTag, persistentWorld = false, overrideCharName = null) {
    const settings = extension_settings.pac;
    if (!settings?.enabled) return null;

    const characterName = overrideCharName || context.name2;
    if (!characterName) return null;

    clearInjections();

    const budget   = settings.contextBudgetTokens ?? 1200;
    const minEvts  = settings.inject?.minEvents  ?? 0;
    const minSumm  = settings.inject?.minSummary ?? 0;
    let used = 0;
    let layer1Tokens = 0, layer2Tokens = 0, layer3Tokens = 0;
    let layer1Text = '', layer2Text = '', layer3Text = '';

    // Sub-component tracking — individual slices of layer 1 for the preview display
    let profileText = '', profileTokens = 0;
    let worldStateText = '', worldStateTokens = 0;
    let charText = '', charTokens = 0;

    // -------------------------------------------------------------------------
    // Layer 1 — Identity
    //   Your Profile: always persona-scoped (never shared)
    //   World State + Character Knowledge:
    //     persistentWorld=ON  → shared world pool
    //     persistentWorld=OFF → persona-scoped paths
    // -------------------------------------------------------------------------
    if (settings.inject?.identity !== false) {
        try {
            const identity = await loadIdentity(avatarId, worldTag, null);

            if (persistentWorld) {
                // Your Profile (suppress worldFacts — they live in shared pool)
                const personaText = formatIdentity({ ...identity, worldFacts: [] });

                // World State from shared pool
                const sharedWorld  = await loadSharedWorldState(worldTag);
                const worldText    = formatIdentity(sharedWorld);

                const combined = [personaText, worldText].filter(Boolean).join('\n\n');
                if (combined) {
                    setExtensionPrompt(KEY_IDENTITY, combined, IN_CHAT, 1, false, SYSTEM);
                    layer1Text   = combined;
                    layer1Tokens = est(combined);
                    used += layer1Tokens;
                }
                profileText      = personaText;
                profileTokens    = est(personaText || '');
                worldStateText   = worldText;
                worldStateTokens = est(worldText || '');

                // Character Knowledge from shared pool
                const sharedChar    = await loadSharedCharKnowledge(worldTag, characterName);
                const charIdentText = formatCharacterIdentity(sharedChar, characterName);
                if (charIdentText) {
                    setExtensionPrompt(KEY_CHAR_IDENTITY, charIdentText, IN_CHAT, 1, false, SYSTEM);
                    layer1Tokens += est(charIdentText);
                    used += est(charIdentText);
                    layer1Text = layer1Text ? `${layer1Text}\n\n${charIdentText}` : charIdentText;
                }
                charText   = charIdentText;
                charTokens = est(charIdentText || '');
            } else {
                // Your Profile (includes worldFacts when persistentWorld=OFF)
                const personaText = formatIdentity(identity);

                // Track profile and world state separately for display
                const profileOnlyText  = formatIdentity({ ...identity, worldFacts: [] });
                const wfList           = identity.worldFacts || [];
                const wfText           = wfList.length
                    ? `[World State]\n${wfList.map(w => `• ${w.fact}`).join('\n')}`
                    : '';
                profileText      = profileOnlyText;
                profileTokens    = est(profileOnlyText || '');
                worldStateText   = wfText;
                worldStateTokens = est(wfText || '');

                if (personaText) {
                    setExtensionPrompt(KEY_IDENTITY, personaText, IN_CHAT, 1, false, SYSTEM);
                    layer1Text   = personaText;
                    layer1Tokens = est(personaText);
                    used += layer1Tokens;
                }

                // Character Knowledge from persona-scoped path
                const charIdentity  = await loadIdentity(avatarId, worldTag, characterName);
                const charIdentText = formatCharacterIdentity(charIdentity, characterName);
                if (charIdentText) {
                    setExtensionPrompt(KEY_CHAR_IDENTITY, charIdentText, IN_CHAT, 1, false, SYSTEM);
                    layer1Tokens += est(charIdentText);
                    used += est(charIdentText);
                    layer1Text = layer1Text ? `${layer1Text}\n\n${charIdentText}` : charIdentText;
                }
                charText   = charIdentText;
                charTokens = est(charIdentText || '');
            }

            if (used > budget - minSumm - minEvts) {
                console.warn(`[PAC] Layer 1 (${layer1Tokens} tk) leaves < ${minSumm + minEvts} tk for summary+events minimums. Consider raising the budget.`);
            }
        } catch (err) {
            console.warn('[PAC] Identity injection failed:', err);
        }
    }

    // -------------------------------------------------------------------------
    // Layer 2 — Summary
    // -------------------------------------------------------------------------
    if (settings.inject?.summary !== false) {
        try {
            const summaries = persistentWorld
                ? await loadSharedSummaries(worldTag, characterName, 1)
                : await loadSummaries(avatarId, worldTag, characterName, 1);
            const text = formatSummaries(summaries, 1);
            const summaryBudget = Math.max(minSumm, budget - used - minEvts);
            if (text && est(text) <= summaryBudget) {
                setExtensionPrompt(KEY_SUMMARY, text, IN_CHAT, 1, false, SYSTEM);
                layer2Text   = text;
                layer2Tokens = est(text);
                used += layer2Tokens;
            }
        } catch (err) {
            console.warn('[PAC] Summary injection failed:', err);
        }
    }

    // -------------------------------------------------------------------------
    // Layer 3 — Events (BM25-retrieved, fills remaining budget)
    // -------------------------------------------------------------------------
    if (settings.inject?.events !== false) {
        try {
            const remaining = Math.max(minEvts, budget - used);
            if (remaining > 50) {
                let relevantEvents = [];

                const lastUserMsg = [...(context.chat || [])].reverse().find(m => m.is_user);
                if (lastUserMsg?.mes) {
                    const topK = settings.eventTopK || 10;
                    const [bm25Res, vecRes] = await Promise.all([
                        persistentWorld
                            ? searchSharedEvents(worldTag, characterName, lastUserMsg.mes, topK).catch(() => [])
                            : searchEvents(avatarId, worldTag, characterName, lastUserMsg.mes, topK).catch(() => []),
                        // Vector search uses persona-scoped index; skip for shared pool (BM25 covers it)
                        persistentWorld
                            ? Promise.resolve([])
                            : queryVectorEvents(avatarId, worldTag, characterName, lastUserMsg.mes, topK).catch(() => []),
                    ]);
                    relevantEvents = rrfMerge(bm25Res, vecRes);
                }

                if (!relevantEvents.length) {
                    const allEvents = persistentWorld
                        ? await readSharedEvents(worldTag, characterName, { limit: 8 })
                        : await readEvents(avatarId, worldTag, characterName, { limit: 8 });
                    relevantEvents = allEvents.slice(-8).map(e => ({ event: e.event, ts: e.ts }));
                }

                let eventText = '';
                for (let n = relevantEvents.length; n > 0; n--) {
                    const candidate = formatEvents(relevantEvents.slice(0, n), n);
                    if (est(candidate) <= remaining) {
                        eventText = candidate;
                        break;
                    }
                }

                if (eventText) {
                    setExtensionPrompt(KEY_EVENTS, eventText, IN_CHAT, 1, false, ASSISTANT);
                    layer3Text   = eventText;
                    layer3Tokens = est(eventText);
                }
            }
        } catch (err) {
            console.warn('[PAC] Event injection failed:', err);
        }
    }

    return {
        // Named sub-components — map directly to the UI tabs
        profileText,    profileTokens,
        worldStateText, worldStateTokens,
        charText,       charTokens,
        // Combined layer totals (backward compat)
        layer1: layer1Tokens,
        layer2: layer2Tokens,
        layer3: layer3Tokens,
        layer1Text,
        layer2Text,
        layer3Text,
        used: layer1Tokens + layer2Tokens + layer3Tokens,
        budget,
    };
}

/** Remove all PAC injection slots. */
export function clearInjections() {
    for (const key of [KEY_IDENTITY, KEY_CHAR_IDENTITY, KEY_SUMMARY, KEY_EVENTS]) {
        setExtensionPrompt(key, '', IN_CHAT, 0);
    }
}
