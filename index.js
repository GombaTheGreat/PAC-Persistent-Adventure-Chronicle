/**
 * PAC — Persistent Adventure Chronicle — layered persistent memory for SillyTavern.
 *
 * Three layers, scoped per persona + world (detected from character card tags):
 *   1. Identity    — persona standing + world facts + character state (permanent)
 *   2. Summary     — compressed session history per character
 *   3. Event Log   — episodic events per character, RAG-retrieved
 *
 * The extension is INACTIVE when no world tag is matched. No data is saved and
 * nothing is injected. The status bar shows a message explaining why.
 */

import { eventSource, event_types, saveSettingsDebounced, generateRaw } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { user_avatar } from '../../../personas.js';

import { loadIdentity, storeIdentity, invalidateIdentityCache, invalidateCharacterCacheEntry, applyIdentityExtraction, emptyIdentity,
    loadSharedWorldState, storeSharedWorldState, applySharedWorldFacts,
    loadSharedCharKnowledge, storeSharedCharKnowledge, invalidateSharedCache } from './src/identity-store.js';
import { logEvent, logSharedEvent } from './src/event-log.js';
import { purgeEventVectors, rebuildEventIndex } from './src/vector-store.js';
import { generateSessionSummary, generateSharedSessionSummary, DEFAULT_SUMMARY_PROMPT } from './src/summary.js';
import { runExtraction, hasContent, showApprovalDialog, DEFAULT_EXTRACTION_PROMPT } from './src/extractor.js';
import { buildAndInjectContext, clearInjections } from './src/injector.js';
import { healthCheck, listPersonas, deletePersonaData, exportPersona, importPersona, getWorldList, deleteWorld, deleteCharData, getEvents, appendEvent, deleteEvent, clearEvents, bulkDeleteEvents, updateEvent, getSummaries, appendSummary, deleteSummary, clearSummaries, updateSummary,
    getSharedEvents, appendSharedEvent, bulkDeleteSharedEvents, getSharedSummaries, appendSharedSummary,
    deleteSharedEvent, clearSharedEvents, deleteSharedSummary, clearSharedSummaries, updateSharedSummary, updateSharedEvent } from './src/api.js';

const MODULE_NAME = 'pac';

// ---------------------------------------------------------------------------
// Built-in world tag master list
// ---------------------------------------------------------------------------

export const BUILTIN_WORLD_TAGS = [
    'Adolion',
    'Aegis Academy',
    'Aegis City Heroes',
    'Aegis City Hunters',
    'Harmony Heroine',
    'Love is a Battlefield',
    'Space Adolion',
    'Voruun',
    'Wisper Division',
    'Zombie Apocalypse',
    'Ozone Corp.',
    'Space Mongols',
];

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULT_CONSOLIDATION_PROMPT =
    'You are a memory consolidation assistant for a roleplay session.\n' +
    'Review the episodic events below. Identify groups of 2 or more events that tell\n' +
    'a coherent arc or describe the same ongoing relationship/situation.\n' +
    'For each group, write ONE consolidated memory that captures the arc\'s conclusion\n' +
    'or current status — as if the arc is now settled history.\n\n' +
    'Rules:\n' +
    '• Only consolidate if the events genuinely belong together.\n' +
    '• Do not consolidate unique standalone events.\n' +
    '• Keep the consolidated memory concise (1-2 sentences).\n' +
    '• Never invent details not present in the original events.\n\n' +
    'Return JSON:\n' +
    '{ "consolidations": [{ "summary": "...", "replaces": [0, 2, 5] }] }\n' +
    'Return {} if nothing should be consolidated.\n' +
    'Return ONLY the JSON. No commentary, no markdown fences.\n\n' +
    'Events (index: text):\n{{events}}';

const DEFAULT_SETTINGS = {
    enabled: true,
    contextBudgetTokens: 1200,
    worldTags: [...BUILTIN_WORLD_TAGS],   // user-editable master list
    worldSettings: {},                     // { [worldTag]: { persistentWorld: false } }
    inject: {
        identity: true,
        summary: true,
        events: true,
        minIdentity: 0,   // informational — identity always injects in full
        minSummary:  0,   // reserved from events' budget ceiling
        minEvents:   0,   // guaranteed minimum for event layer (enforced)
    },
    eventTopK: 8,
    extraction: {
        enabled: true,
        intervalMessages: 30,
        requireApproval: true,
        prompt: DEFAULT_EXTRACTION_PROMPT,
    },
    summary: {
        prompt: DEFAULT_SUMMARY_PROMPT,
        targetWords: 200,
        autoIntervalMessages: 50,
        summaryWindowMessages: 50,
    },
    consolidation: {
        prompt: DEFAULT_CONSOLIDATION_PROMPT,
        autoThreshold: 100,   // suggest consolidation when event count exceeds this (0 = disabled)
    },
    customIdentityFields: [],  // user-defined field names tracked in identity.custom
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pluginOnline = false;            // set true after successful health check
let lastExtractionAtChatLength = 0;  // chat.length at time of last extraction; counts all messages
let lastSummaryAtChatLength = 0;     // chat.length at time of last summary; counts all messages
let currentCharacterName = null;
let currentPersonaId = null;
let currentWorldTag = null;          // null = no world matched = extension inactive
let isGeneratingSummary = false;
let lastSummaryGeneratedAt = 0;       // epoch ms — guards against rapid double-generation
let isExtracting = false;
let lastInjectionBreakdown = null;
let _loadedEvents = [];          // cache for event search filtering

// ---------------------------------------------------------------------------
// Persona helpers
// ---------------------------------------------------------------------------

function resolvePersonaId() {
    return user_avatar || 'default';
}

function invalidateAllCaches(avatarId) {
    if (!avatarId) return;
    invalidateIdentityCache(avatarId);
    if (currentWorldTag) invalidateSharedCache(currentWorldTag);
}

// ---------------------------------------------------------------------------
// World tag detection
// ---------------------------------------------------------------------------

/**
 * Case-insensitive match of a character's tags against the world tag master list.
 * Returns the canonical tag name (casing taken from the master list) so all saved
 * data uses a consistent key regardless of how the tag was typed on the card.
 * @param {string[]} charTags   Tags from the character card / ST UI
 * @param {string[]} worldTags  Master list from settings
 * @returns {string|null}
 */
function matchWorldTag(charTags, worldTags) {
    const lowerMap = new Map(worldTags.map(t => [t.toLowerCase(), t]));
    for (const tag of charTags) {
        const canonical = lowerMap.get(tag.toLowerCase());
        if (canonical !== undefined) return canonical;
    }
    return null;
}

/**
 * Get all tags for the current character card.
 * Checks both the V2 card spec tags (data.tags) and ST's UI tag system.
 * @returns {string[]}
 */
function getCharacterTags() {
    const context = getContext();
    const char = context.characters?.[context.characterId];

    // V2 spec tags (from the character card file itself)
    const cardTags = char?.data?.tags || [];

    // ST's own UI tag system (tags added via the character browser)
    let uiTags = [];
    try {
        // tag_map maps avatar filename → array of tag IDs
        // tags (the global) maps tag IDs → { id, name, ... }
        const { tag_map, tags: stTags } = /** @type {any} */ (window);
        const charAvatar = char?.avatar;
        if (charAvatar && tag_map && stTags) {
            const tagIds = tag_map[charAvatar] || [];
            uiTags = tagIds.map(id => stTags.find(t => t.id === id)?.name).filter(Boolean);
        }
    } catch {
        // ST tag system not accessible via window globals — fall back to card tags only
    }

    return [...new Set([...cardTags, ...uiTags])];
}

/**
 * Detect which world the current character belongs to.
 * Returns the first tag that matches the master list, or null if none match.
 * @returns {string|null}
 */
function detectWorldTag() {
    const context = getContext();
    // In group chats context.characterId is null — scan members instead
    if (context.groupId) return detectWorldTagInGroup(context);
    const charTags = getCharacterTags();
    if (!charTags.length) return null;
    const worldTags = getSettings().worldTags || BUILTIN_WORLD_TAGS;
    return matchWorldTag(charTags, worldTags);
}

/**
 * Collect all tags for a named character — checks both V2 card tags and ST's UI tag system.
 * Single source of truth shared by detectWorldTagForCharName() and isNarratorChar() to avoid
 * duplicating the tag-fetching logic in both functions.
 * @param {string} charName
 * @returns {string[]}
 */
function getAllTagsForCharName(charName) {
    if (!charName) return [];
    const context = getContext();
    const charObj = (context.characters || []).find(c => c.name === charName);
    if (!charObj) return [];

    // V2 spec tags embedded in the card file
    const cardTags = charObj.data?.tags || [];

    // ST UI tags (added via character browser)
    let uiTags = [];
    try {
        const { tag_map, tags: stTags } = /** @type {any} */ (window);
        const charAvatar = charObj.avatar;
        if (charAvatar && tag_map && stTags) {
            const tagIds = tag_map[charAvatar] || [];
            uiTags = tagIds.map(id => stTags.find(t => t.id === id)?.name).filter(Boolean);
        }
    } catch {
        // ST tag system not accessible — fall back to card tags only
    }

    return [...new Set([...cardTags, ...uiTags])];
}

/**
 * Detect the world tag for a specific character name — used in group chats where the
 * responding character (context.name2) changes each generation.
 * @param {string} charName
 * @returns {string|null}
 */
function detectWorldTagForCharName(charName) {
    const worldTags = getSettings().worldTags || BUILTIN_WORLD_TAGS;
    return matchWorldTag(getAllTagsForCharName(charName), worldTags);
}

/**
 * Scan all group members for a world tag.
 * Returns the first match found, or null.
 * Called by detectWorldTag() when context.groupId is set.
 * Disabled members are included — users are expected to remove unwanted
 * characters from the group rather than relying on the disabled flag.
 * @param {object} context  result of getContext()
 * @returns {string|null}
 */
function detectWorldTagInGroup(context) {
    const group = (context.groups || []).find(g => g.id === context.groupId);
    if (!group) return null;
    for (const memberAvatar of (group.members || [])) {
        const charName = (context.characters || []).find(c => c.avatar === memberAvatar)?.name;
        if (!charName) continue;
        const tag = detectWorldTagForCharName(charName);
        if (tag) return tag;
    }
    return null;
}

/**
 * Resolve the active character name in a group-chat-aware way.
 * In solo chats returns context.name2 directly.
 * In group chats at idle (context.name2 is null), falls back to:
 *   1. Last non-user message sender in chat history  (most recently active char)
 *   2. First non-narrator group member               (fresh group, no messages yet)
 * This lets all manual operations (extraction, summary, overview, etc.) work
 * without requiring an active generation to populate context.name2.
 * @returns {string|null}
 */
function resolveCurrentCharName() {
    const context = getContext();
    if (context.name2) return context.name2;
    if (!context.groupId) {
        // Solo chat: context.name2 is null at idle — resolve via characterId
        return context.characters?.[context.characterId]?.name || null;
    }
    // Walk chat history backwards for the last non-user sender
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && chat[i].name) return chat[i].name;
    }
    // No messages yet — use first non-narrator group member
    const group = (context.groups || []).find(g => g.id === context.groupId);
    for (const av of (group?.members || [])) {
        const name = (context.characters || []).find(c => c.avatar === av)?.name;
        if (name && !isNarratorChar(name)) return name;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Narrator character detection
// ---------------------------------------------------------------------------

/**
 * True if the character with this name has the ST card tag "Narrator" (case-insensitive).
 * Works in both solo and group chats.
 * @param {string} characterName
 * @returns {boolean}
 */
function isNarratorChar(characterName) {
    if (!characterName) return false;
    return getAllTagsForCharName(characterName).some(t => t.toLowerCase() === 'narrator');
}

/**
 * Find non-narrator character names who responded in recentMessages.
 * Used for cross-attribution when a narrator fires extraction: events are
 * logged to real scene participants rather than the narrator itself.
 * @param {Array} recentMessages  ST chat messages [{name, is_user, mes}]
 * @returns {string[]}  Ordered unique names (first appearance first)
 */
function getSceneParticipants(recentMessages) {
    const seen = new Set();
    const result = [];
    for (const msg of recentMessages) {
        if (msg.is_user || !msg.name) continue;
        if (isNarratorChar(msg.name)) continue;
        if (seen.has(msg.name)) continue;
        seen.add(msg.name);
        result.push(msg.name);
    }
    return result;
}

// ---------------------------------------------------------------------------
// World settings helpers
// ---------------------------------------------------------------------------

function getWorldSettings(worldTag) {
    const s = getSettings();
    return { persistentWorld: false, ...(s.worldSettings?.[worldTag] || {}) };
}

function setWorldSetting(worldTag, key, value) {
    const s = getSettings();
    if (!s.worldSettings) s.worldSettings = {};
    if (!s.worldSettings[worldTag]) s.worldSettings[worldTag] = {};
    s.worldSettings[worldTag][key] = value;
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE_NAME];
    s.inject               = { ...DEFAULT_SETTINGS.inject,         ...s.inject };
    s.extraction           = { ...DEFAULT_SETTINGS.extraction,     ...s.extraction };
    s.summary              = { ...DEFAULT_SETTINGS.summary,        ...s.summary };
    s.consolidation        = { ...DEFAULT_SETTINGS.consolidation,  ...s.consolidation };
    if (!Array.isArray(s.customIdentityFields)) s.customIdentityFields = [];
    if (s.contextBudgetTokens == null) s.contextBudgetTokens = DEFAULT_SETTINGS.contextBudgetTokens;
    if (s.eventTopK == null) s.eventTopK = DEFAULT_SETTINGS.eventTopK;
    if (!s.worldTags)     s.worldTags    = [...BUILTIN_WORLD_TAGS];
    if (!s.worldSettings) s.worldSettings = {};
    // Clean up legacy vectorSearch settings if present
    delete s.vectorSearch;
    return s;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onSettingsLoaded() {
    getSettings();
}

async function onChatChanged() {
    const context = getContext();
    const newPersonaId = resolvePersonaId();
    const newCharName  = resolveCurrentCharName();

    // Reset interval counters to the current chat length so the clock starts fresh
    // from the moment we enter this chat, not from the beginning of its history.
    const chatLen = context.chat?.length || 0;

    if (newPersonaId !== currentPersonaId) {
        invalidateAllCaches(currentPersonaId);
        currentPersonaId = newPersonaId;
        lastExtractionAtChatLength = chatLen;
        lastSummaryAtChatLength    = chatLen;
    }

    if (newCharName !== currentCharacterName) {
        currentCharacterName       = newCharName;
        lastExtractionAtChatLength = chatLen;
        lastSummaryAtChatLength    = chatLen;
    }

    currentWorldTag = detectWorldTag();
    clearInjections();
    updateMemoryStatus().catch(() => {});
    updateHealthChecks();
    updateAutoCounters();

    // Reload injection for the new character/chat
    if (currentWorldTag) {
        const avatarId = currentPersonaId || resolvePersonaId();
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        buildAndInjectContext(context, avatarId, currentWorldTag, persistentWorld, currentCharacterName)
            .then(bd => { lastInjectionBreakdown = bd || null; updateBudgetDisplay(); })
            .catch(() => {});
    }
}

async function onChatLoaded() {
    const context = getContext();
    currentPersonaId    = resolvePersonaId();
    currentCharacterName = resolveCurrentCharName();
    currentWorldTag     = detectWorldTag();
    lastExtractionAtChatLength = context.chat?.length || 0;
    lastSummaryAtChatLength    = context.chat?.length || 0;
    clearInjections();
    updateMemoryStatus().catch(() => {});
    updateHealthChecks();
    updateAutoCounters();

    // Pre-load injection so the first generation in this session has memory.
    // generate_before_combine_prompts doesn't fire in all ST builds, so
    // setExtensionPrompt is called here and after each message_received instead.
    if (currentWorldTag) {
        const avatarId = currentPersonaId || resolvePersonaId();
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        buildAndInjectContext(context, avatarId, currentWorldTag, persistentWorld, currentCharacterName)
            .then(bd => { lastInjectionBreakdown = bd || null; updateBudgetDisplay(); })
            .catch(() => {});
    }
}

async function onSettingsUpdated() {
    const newPersonaId = resolvePersonaId();
    if (newPersonaId !== currentPersonaId) {
        invalidateAllCaches(currentPersonaId);
        currentPersonaId = newPersonaId;
        const _chatLen = getContext().chat?.length || 0;
        lastExtractionAtChatLength = _chatLen;
        lastSummaryAtChatLength    = _chatLen;
        clearInjections();
        updatePersonaIndicator();
        updateMemoryStatus().catch(() => {});
    }
}

async function onMessageReceived() {
    const settings = getSettings();
    if (!settings.enabled) return;

    // Re-detect in case CHAT_LOADED fired before window.tag_map was ready
    if (!currentWorldTag) currentWorldTag = detectWorldTag();
    if (!currentWorldTag) return;

    // Use total chat length (user + AI messages) so the interval fires at the same
    // rate regardless of how many characters respond per round in a group chat.
    const context = getContext();
    const chatLen = context.chat?.length || 0;

    if (settings.extraction.enabled) {
        if (chatLen - lastExtractionAtChatLength >= settings.extraction.intervalMessages) {
            lastExtractionAtChatLength = chatLen;
            await triggerExtractionForChat();
        }
    }

    const summaryInterval = settings.summary.autoIntervalMessages || 0;
    if (summaryInterval > 0) {
        if (chatLen - lastSummaryAtChatLength >= summaryInterval) {
            lastSummaryAtChatLength = chatLen;
            await generateSummaryForChat({ silent: true });
        }
    }

    // Always update counters so the Preview tab stays current.
    updateAutoCounters();

    // In group chats, onGroupMemberDrafted handles injection for the correct
    // character — ST awaits that handler so injection is guaranteed complete
    // before Generate() runs. Pre-injecting here would race against the next
    // character's onGroupMemberDrafted call: both async buildAndInjectContext
    // calls write to the same slots, and whichever server round-trip finishes
    // last wins — producing intermittent wrong-character injection.
    if (context.groupId) return;

    // Solo chat fallback: generate_before_combine_prompts doesn't fire in all
    // ST builds. setExtensionPrompt slots persist, so pre-loading here ensures
    // data is available for the next generation in those builds.
    const avatarId = resolvePersonaId();
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    const charName = context.name2 || currentCharacterName;
    lastInjectionBreakdown = await buildAndInjectContext(
        context, avatarId, currentWorldTag, persistentWorld, charName
    ) || null;
    updateBudgetDisplay();
    renderInjectionPreview(lastInjectionBreakdown);
}

async function onGroupMemberDrafted(chId) {
    // Fires after ST selects the next group member but before Generate() is called.
    // ST AWAITS this handler — injection done here is guaranteed to complete and
    // persist into the prompt regardless of whether GENERATE_BEFORE_COMBINE_PROMPTS
    // fires in the current ST build.
    const context = getContext();
    const char = context.characters?.[chId];
    if (!char?.name) return;
    const tag = detectWorldTagForCharName(char.name);
    if (!tag) return;
    const avatarId = resolvePersonaId();
    const { persistentWorld } = getWorldSettings(tag);

    // Update module state so onBeforeGenerate and onMessageReceived see the right character.
    currentWorldTag      = tag;
    currentCharacterName = char.name;

    // Full injection with the correct character. This is the definitive injection
    // point for group chats — ST awaits this before calling Generate().
    lastInjectionBreakdown = await buildAndInjectContext(
        context, avatarId, tag, persistentWorld, char.name
    ) || null;
    updateBudgetDisplay();
    renderInjectionPreview(lastInjectionBreakdown);
}

async function onBeforeGenerate() {
    const context = getContext();

    // Group chat: the responding character (context.name2) changes each generation.
    // Always re-detect (and potentially clear) so we never carry over a previous
    // character's world tag when a character with no tag is about to respond.
    if (context.groupId && context.name2) {
        currentWorldTag      = detectWorldTagForCharName(context.name2);
        currentCharacterName = context.name2;
    }

    if (!currentWorldTag) {
        clearInjections();
        return;
    }

    // Narrator guard: narrator characters never receive memory injections
    if (isNarratorChar(context.name2)) {
        clearInjections();
        return;
    }

    // Group chats: onGroupMemberDrafted already ran buildAndInjectContext with the
    // correct character and ST awaited it — slots are already set. Calling it again
    // here would double-fetch Layers 2 & 3 (no cache) for no benefit. Update the
    // status line and return.
    if (context.groupId) {
        updateMemoryStatus().catch(() => {});
        return;
    }

    // Solo chats: GENERATE_BEFORE_COMBINE_PROMPTS is our primary injection hook.
    const avatarId = resolvePersonaId();
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    const charNameForInjection = context.name2 || currentCharacterName;
    lastInjectionBreakdown = await buildAndInjectContext(context, avatarId, currentWorldTag, persistentWorld, charNameForInjection) || null;
    updateBudgetDisplay();
    renderInjectionPreview(lastInjectionBreakdown);
}

// ---------------------------------------------------------------------------
// Extraction flow
// ---------------------------------------------------------------------------

/**
 * All tagged, non-narrator members of the current group.
 * Used to distribute scene-level extractions and summaries to every participant.
 * @param {object} context  result of getContext()
 * @returns {string[]}  character names
 */
function getGroupTargetChars(context) {
    const group = (context.groups || []).find(g => g.id === context.groupId);
    if (!group) return [];
    return (group.members || [])
        .map(av => (context.characters || []).find(c => c.avatar === av)?.name)
        .filter(name => name && !isNarratorChar(name) && detectWorldTagForCharName(name));
}

/**
 * Dispatch extraction for the current chat context.
 * Solo: one LLM call for the single character.
 * Group: one LLM call covering all tagged non-narrator members — single dialog, correct per-character saves.
 * @param {{ fullHistory?: boolean }} options
 */
async function triggerExtractionForChat({ fullHistory = false } = {}) {
    const context = getContext();
    if (!context.groupId) {
        await triggerExtraction({ fullHistory });
        return;
    }
    const groupChars = getGroupTargetChars(context);
    if (!groupChars.length) return;
    await triggerExtraction({ fullHistory, groupCharNames: groupChars });
}

async function triggerExtraction({ fullHistory = false, groupCharNames = null } = {}) {
    if (isExtracting || !currentWorldTag) return;
    isExtracting = true;

    // Capture world/character state NOW — the user may switch characters
    // during the async LLM calls below, and we must write to the correct world.
    const worldTag      = currentWorldTag;
    const avatarId      = currentPersonaId || resolvePersonaId();

    // Visual indicator: update status bar while extraction runs
    const prevStatus = $('#ms-memory-status').text();
    $('#ms-memory-status').text(fullHistory ? 'Full extraction running…' : 'Extracting memory…');

    try {
        const context = getContext();
        const characterName = resolveCurrentCharName();
        if (!characterName) return;

        // In group mode narrators are already excluded from groupCharNames — treat as non-narrator.
        // In solo mode, check normally so narrator cross-attribution still works.
        const narratorMode = groupCharNames?.length ? false : isNarratorChar(characterName);

        const settings = getSettings();
        const lastN = fullHistory ? 9999 : settings.extraction.intervalMessages;
        const recentMessages = (context.chat || []).slice(-lastN);

        // Pass speaker attribution so the extraction LLM knows which names are AI characters vs the user persona.
        // Group mode: characterNames array → LLM produces per-character "characters" map.
        // Solo mode / narrator: single characterName or empty attribution.
        const attribution = narratorMode
            ? {}
            : groupCharNames?.length
                ? { characterNames: groupCharNames, personaName: context.name1 || '' }
                : { characterName, personaName: context.name1 || '' };

        const extraction = await runExtraction(
            recentMessages,
            settings.extraction.prompt,
            settings.customIdentityFields || [],
            attribution
        );
        if (!extraction || !hasContent(extraction)) return;

        // targetChars determines who receives the extracted events.
        // Group mode: all tagged non-narrator members (passed in as groupCharNames).
        // Narrator solo: scene participants detected from recent history.
        // Regular solo: just the responding character.
        let targetChars;
        if (groupCharNames?.length) {
            targetChars = groupCharNames;
        } else if (narratorMode) {
            // Use a wider window for participant detection than the LLM extraction window
            // so group members who haven't spoken recently are still attributed events.
            // Fixed 3× multiplier — avoids relying on context.characters.length, which is the
            // full character library (potentially hundreds of cards), not just the group members.
            const participantMessages = (context.chat || []).slice(-(lastN * 3));
            targetChars = getSceneParticipants(participantMessages);
        } else {
            targetChars = [characterName];
        }

        if (targetChars.length === 0) {
            console.debug('[PAC] Extraction: no target characters found, skipping.');
            return;
        }

        // Dialog label:
        //   Group mode   → "Group: CharA, CharB, CharC"
        //   Narrator solo → "Scene → CharA, CharB"
        //   Regular solo  → character name
        const dialogLabel = groupCharNames?.length
            ? `Group: ${groupCharNames.join(', ')}`
            : narratorMode
                ? `Scene → ${targetChars.join(', ')}`
                : characterName;

        // In narrator mode, characterFacts/characters can't be attributed unambiguously —
        // strip them before the approval dialog so users never approve items that would be discarded.
        const extractionForSave = narratorMode
            ? { ...extraction, characterFacts: {}, characters: {} }
            : extraction;

        // If narrator stripping leaves nothing actionable, bail out silently
        if (narratorMode && !hasContent(extractionForSave)) return;

        let approved = extractionForSave;
        if (settings.extraction.requireApproval) {
            const result = await showApprovalDialog(extractionForSave, dialogLabel);
            if (!result) return;
            approved = result;
        }

        const { persistentWorld } = getWorldSettings(worldTag);

        // Your Profile (persona identity) — always persona-scoped, always world-level.
        if (Object.keys(approved.personaFacts || {}).length) {
            const identity = await loadIdentity(avatarId, worldTag, null);
            applyIdentityExtraction(identity, approved.personaFacts || {}, [], context.chatId);
            await storeIdentity(avatarId, worldTag, identity, null);
        }

        // World State — shared pool when ON, embedded in persona identity when OFF.
        if (approved.worldFacts?.length) {
            if (persistentWorld) {
                await applySharedWorldFacts(worldTag, approved.worldFacts, context.chatId);
            } else {
                const identity = await loadIdentity(avatarId, worldTag, null);
                applyIdentityExtraction(identity, {}, approved.worldFacts, context.chatId);
                await storeIdentity(avatarId, worldTag, identity, null);
            }
        }

        // Character Knowledge — save per-character facts.
        // Group mode: iterate approved.characters map (each entry goes to its named character).
        // Solo mode: use legacy approved.characterFacts (single character, skipped for narrator).
        if (approved.characters && Object.keys(approved.characters).length) {
            for (const [charName, charFacts] of Object.entries(approved.characters)) {
                if (!charFacts || !Object.keys(charFacts).length) continue;
                if (persistentWorld) {
                    const charIdentity = await loadSharedCharKnowledge(worldTag, charName);
                    applyIdentityExtraction(charIdentity, charFacts, [], context.chatId);
                    await storeSharedCharKnowledge(worldTag, charName, charIdentity);
                } else {
                    const charIdentity = await loadIdentity(avatarId, worldTag, charName);
                    applyIdentityExtraction(charIdentity, charFacts, [], context.chatId);
                    await storeIdentity(avatarId, worldTag, charIdentity, charName);
                }
            }
        } else if (!narratorMode && Object.keys(approved.characterFacts || {}).length) {
            // Legacy solo path
            if (persistentWorld) {
                const charIdentity = await loadSharedCharKnowledge(worldTag, characterName);
                applyIdentityExtraction(charIdentity, approved.characterFacts, [], context.chatId);
                await storeSharedCharKnowledge(worldTag, characterName, charIdentity);
            } else {
                const charIdentity = await loadIdentity(avatarId, worldTag, characterName);
                applyIdentityExtraction(charIdentity, approved.characterFacts, [], context.chatId);
                await storeIdentity(avatarId, worldTag, charIdentity, characterName);
            }
        }

        refreshIdentityPanel();

        // Memories — shared pool when ON, persona-scoped when OFF.
        for (const event of (approved.events || [])) {
            for (const targetChar of targetChars) {
                if (persistentWorld) {
                    await logSharedEvent(worldTag, targetChar, event, ['extracted'], context.chatId);
                } else {
                    await logEvent(avatarId, worldTag, targetChar, event, ['extracted'], context.chatId);
                }
            }
        }

        updateMemoryStatus().catch(() => {});

        // Refresh the Events tab if it's open (so newly extracted events appear immediately)
        if ($('.ms-tab-content[data-tab="events"]').is(':visible')) {
            const searchVal = $('#ms-event-search').val() || '';
            await loadEventLog();
            // Re-apply the active search filter if there was one
            if (searchVal.trim()) filterEventLog(searchVal);
        }

        // Auto-threshold: notify user if event log is getting large.
        // Use captured worldTag — currentWorldTag may have changed during the LLM calls.
        const threshold = getSettings().consolidation?.autoThreshold ?? 100;
        if (threshold > 0 && characterName) {
            try {
                const { persistentWorld: pwThreshold } = getWorldSettings(worldTag);
                const allEvents = pwThreshold
                    ? await getSharedEvents(worldTag, characterName, { limit: 1000 })
                    : await getEvents(avatarId, worldTag, characterName, { limit: 1000 });
                if (allEvents.length >= threshold) {
                    toastr.info(
                        `Memories log has ${allEvents.length} entries — consider consolidating. ` +
                        `<a href="#" id="ms-toast-open-consolidate">Open Memories → Advanced</a>`,
                        'PAC',
                        { timeOut: 8000, extendedTimeOut: 4000, closeButton: true }
                    );
                    // Open Events tab + expand Advanced when toast link is clicked
                    $(document).one('click', '#ms-toast-open-consolidate', function (e) {
                        e.preventDefault();
                        $('.ms-tab').removeClass('active');
                        $('.ms-tab[data-tab="events"]').addClass('active');
                        $('.ms-tab-content').addClass('hidden');
                        $('.ms-tab-content[data-tab="events"]').removeClass('hidden');
                        $('#ms-events-advanced-panel').removeClass('hidden');
                    });
                }
            } catch { /* non-critical */ }
        }
    } catch (err) {
        console.error('[PAC] Extraction failed:', err);
        toastr.error('[PAC] Memory extraction failed — check the console for details.');
    } finally {
        isExtracting = false;
        // Restore status bar (updateMemoryStatus will have set it correctly if extraction succeeded;
        // on failure we restore the previous text so the bar doesn't freeze on "Extracting memory…")
        if ($('#ms-memory-status').text() === 'Extracting memory…') {
            $('#ms-memory-status').text(prevStatus);
        }
    }
}

// ---------------------------------------------------------------------------
// Memory consolidation
// ---------------------------------------------------------------------------

async function triggerConsolidation() {
    if (!currentWorldTag) return toastr.warning('No world tag detected for this character.');
    const context       = getContext();
    const characterName = resolveCurrentCharName();
    if (!characterName)  return toastr.warning('No character active.');
    if (isNarratorChar(characterName)) return toastr.info('Narrator character — consolidation not applicable.');

    const avatarId = resolvePersonaId();
    const settings = getSettings();

    const { persistentWorld } = getWorldSettings(currentWorldTag);
    toastr.info('Loading memories for consolidation…');

    let allEvents;
    try {
        allEvents = persistentWorld
            ? await getSharedEvents(currentWorldTag, characterName, { limit: 1000 })
            : await getEvents(avatarId, currentWorldTag, characterName, { limit: 1000 });
    } catch (err) {
        return toastr.error('Failed to load memories.');
    }

    // Keep the 20 most recent out of scope so fresh context isn't touched
    const KEEP_RECENT = 20;
    const candidateEvents = allEvents.slice(0, Math.max(0, allEvents.length - KEEP_RECENT));
    if (candidateEvents.length < 2) {
        return toastr.info('Not enough memories to consolidate (need at least 2 older memories).');
    }

    // For very large logs send in chunks of 150
    const CHUNK = 150;
    let allConsolidations = [];
    for (let offset = 0; offset < candidateEvents.length; offset += CHUNK) {
        const chunk = candidateEvents.slice(offset, offset + CHUNK);
        const eventLines       = chunk.map((e, i) => `${offset + i}: ${e.event || '(empty)'}`).join('\n');
        const template         = settings.consolidation?.prompt || DEFAULT_CONSOLIDATION_PROMPT;
        const systemPromptPart = template.split('{{events}}')[0].trimEnd();

        toastr.info(`Analysing memories ${offset + 1}–${Math.min(offset + CHUNK, candidateEvents.length)}…`);

        let raw;
        try {
            raw = await generateRaw({ prompt: eventLines, systemPrompt: systemPromptPart, responseLength: 1200 });
        } catch (err) {
            console.error('[PAC] consolidation LLM error:', err);
            toastr.warning(`LLM call failed for chunk ${Math.floor(offset / CHUNK) + 1}, skipping.`);
            continue;
        }

        let parsed;
        try {
            const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            parsed = JSON.parse(jsonText || '{}');
        } catch {
            console.warn('[PAC] consolidation JSON parse failed for chunk');
            continue;
        }

        if (Array.isArray(parsed?.consolidations)) {
            allConsolidations.push(...parsed.consolidations);
        }
    }

    if (!allConsolidations.length) {
        return toastr.info('Nothing to consolidate — no related event groups found.');
    }

    // Build approval dialog HTML
    const groupHtml = allConsolidations.map((g, gi) => {
        const originals = (g.replaces || [])
            .map(idx => {
                const ev = allEvents[idx];
                return ev ? `<li class="ms-hint" style="font-size:0.85em;">${escHtmlUtil(ev.event || '(empty)')}</li>` : '';
            }).join('');
        return `
            <div class="ms-consolidation-group" style="margin-bottom:10px; padding:8px; border:1px solid var(--SmartThemeBorderColor,#3a3a3a); border-radius:5px;">
                <label style="display:flex; gap:8px; align-items:flex-start; cursor:pointer;">
                    <input type="checkbox" class="ms-consolidation-check" data-group="${gi}" checked style="margin-top:3px; flex-shrink:0;">
                    <div>
                        <div style="font-weight:600; margin-bottom:4px; font-size:0.88em;">${escHtmlUtil(g.summary || '')}</div>
                        <details>
                            <summary class="ms-hint" style="cursor:pointer; font-size:0.8em;">Replaces ${(g.replaces || []).length} memor${(g.replaces || []).length !== 1 ? 'ies' : 'y'}</summary>
                            <ul style="margin:4px 0 0 14px; padding:0;">${originals}</ul>
                        </details>
                    </div>
                </label>
            </div>`;
    }).join('');

    const $dlg = $(`
        <div style="max-height:60vh; overflow-y:auto; padding:4px 2px;">
            <p class="ms-hint" style="margin-bottom:10px;">
                Review the consolidation groups below. Checked groups will replace their original memories
                with a single consolidated memory.
            </p>
            ${groupHtml}
        </div>`);

    const confirmed = await new Promise(resolve => {
        let settled = false;
        const $wrapper = $('<div class="ms-approval-dialog">').append(
            $('<div class="ms-dialog-header"><h3>Consolidate Memory</h3><p class="ms-dialog-subtitle">Checked groups will replace their original memories with one consolidated memory.</p></div>'),
            $dlg,
        );
        $wrapper.dialog({
            title: 'PAC — Consolidate Memories',
            width: 540,
            maxHeight: 640,
            modal: true,
            buttons: {
                'Apply Selected': function () {
                    settled = true;
                    $(this).dialog('close');
                    resolve(true);
                },
                'Cancel': function () {
                    settled = true;
                    $(this).dialog('close');
                    resolve(false);
                },
            },
            close: function () {
                if (!settled) resolve(false);
            },
        });
    });

    if (!confirmed) return;

    // Collect approved groups
    const approved = allConsolidations.filter((_, gi) => {
        return $dlg.find(`.ms-consolidation-check[data-group="${gi}"]`).is(':checked');
    });

    if (!approved.length) return toastr.info('No groups selected.');

    // Collect all indices to delete (de-duplicated)
    const toDelete = [...new Set(approved.flatMap(g => g.replaces || []))];

    // Bulk delete old events
    if (persistentWorld) {
        await bulkDeleteSharedEvents(currentWorldTag, characterName, toDelete);
    } else {
        await bulkDeleteEvents(avatarId, currentWorldTag, characterName, toDelete);
    }

    // Append consolidated events
    for (const g of approved) {
        if (g.summary) {
            if (persistentWorld) {
                await appendSharedEvent(currentWorldTag, characterName, { event: g.summary, tags: ['consolidated'] });
            } else {
                await appendEvent(avatarId, currentWorldTag, characterName, { event: g.summary, tags: ['consolidated'] });
            }
        }
    }

    toastr.success(`Consolidated ${approved.length} group${approved.length !== 1 ? 's' : ''} — ${toDelete.length} old memor${toDelete.length !== 1 ? 'ies' : 'y'} replaced.`);
    loadEventLog();

    // Rebuild vector index so semantic search reflects the new consolidated events.
    // Purge first (removes stale embeddings for deleted events), then re-insert all survivors.
    // Vector index is persona-scoped — skip when persistentWorld=ON (BM25 is used there).
    if (!persistentWorld) {
        try {
            const remaining = await getEvents(avatarId, currentWorldTag, characterName, { limit: 2000 });
            await purgeEventVectors(avatarId, currentWorldTag, characterName);
            if (remaining.length) {
                await rebuildEventIndex(avatarId, currentWorldTag, characterName, remaining);
                console.info(`[PAC] Vector index rebuilt after consolidation: ${remaining.length} events re-indexed.`);
            }
        } catch (err) {
            console.warn('[PAC] Vector index update after consolidation failed (non-critical):', err);
        }
    }
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * In group chats: generate a session summary for every tagged non-narrator member.
 * In solo chats: delegates directly to generateSummaryForCurrentChar.
 */
async function generateSummaryForChat({ silent = false } = {}) {
    const context = getContext();
    if (!context.groupId) {
        await generateSummaryForCurrentChar({ silent });
        return;
    }
    const groupChars = getGroupTargetChars(context);
    if (!groupChars.length) return;
    if (!silent) toastr.info(`Generating summaries for ${groupChars.length} character${groupChars.length !== 1 ? 's' : ''}…`);
    for (const charName of groupChars) {
        // Always silent inside the loop — bypasses the 60s cooldown that would block
        // every character after the first, since the cooldown is per-session not per-character.
        await generateSummaryForCurrentChar({ silent: true, charName });
    }
    if (!silent) toastr.success(`Summaries saved for: ${groupChars.join(', ')}.`);
}

async function generateSummaryForCurrentChar({ silent = false, charName = null } = {}) {
    // Resolve worldTag early so the guard works correctly when charName is provided —
    // the character may have a valid tag even if currentWorldTag is null.
    const worldTag = charName ? (detectWorldTagForCharName(charName) || currentWorldTag) : currentWorldTag;
    if (!worldTag) {
        if (!silent) toastr.warning('No world tag detected for this character.');
        return;
    }
    if (isGeneratingSummary) {
        if (!silent) toastr.warning('Already generating a summary.');
        return;
    }
    // Guard against duplicate summaries when the user clicks rapidly or auto-summary fires
    // concurrently with a manual trigger. 60-second cooldown (skipped when silent=true,
    // which is how generateSummaryForChat calls this for each group member).
    const cooldownMs = 60_000;
    if (!silent && Date.now() - lastSummaryGeneratedAt < cooldownMs) {
        toastr.info('A summary was just generated — please wait a moment before generating another.');
        return;
    }

    const context = getContext();
    const characterName = charName || resolveCurrentCharName();
    if (!characterName) {
        if (!silent) toastr.warning('No character selected.');
        return;
    }

    // Capture state before any await — character may change during LLM call
    const avatarId  = currentPersonaId || resolvePersonaId();

    // Narrators don't accumulate their own session summaries
    if (isNarratorChar(characterName)) {
        if (!silent) toastr.info('Narrator character — no summary saved.');
        return;
    }

    isGeneratingSummary = true;
    if (!silent) toastr.info('Generating session summary...');

    try {
        const settings = getSettings();
        const { persistentWorld } = getWorldSettings(worldTag);
        const msgWindow = settings.summary.summaryWindowMessages || 50;
        const summary = persistentWorld
            ? await generateSharedSessionSummary(
                worldTag, characterName,
                context.chat, context.chatId,
                settings.summary.prompt, settings.summary.targetWords, msgWindow,
            )
            : await generateSessionSummary(
                avatarId, worldTag, characterName,
                context.chat, context.chatId,
                settings.summary.prompt, settings.summary.targetWords, msgWindow,
            );

        if (summary) {
            lastSummaryGeneratedAt = Date.now();
            if (!silent) toastr.success('Session summary saved.');
            updateMemoryStatus().catch(() => {});
            if ($('.ms-tab[data-tab="summary"]').hasClass('active')) {
                loadSummaryList();
            }
        } else {
            if (!silent) toastr.error('Summary generation failed.');
        }
    } finally {
        isGeneratingSummary = false;
    }
}

async function generateStorySynopsis() {
    if (!currentWorldTag) { toastr.warning('No world tag detected.'); return; }
    if (isGeneratingSummary) { toastr.warning('Already generating a summary.'); return; }

    const context = getContext();
    const characterName = resolveCurrentCharName();
    if (!characterName) { toastr.warning('No character selected.'); return; }
    if (isNarratorChar(characterName)) { toastr.info('Narrator character — no summary saved.'); return; }

    const avatarId  = currentPersonaId || resolvePersonaId();
    const worldTag  = currentWorldTag;
    const settings  = getSettings();
    const { persistentWorld } = getWorldSettings(worldTag);

    isGeneratingSummary = true;
    toastr.info('Generating story synopsis (full chat history)...');

    try {
        const summary = persistentWorld
            ? await generateSharedSessionSummary(
                worldTag, characterName,
                context.chat, context.chatId,
                settings.summary.prompt, settings.summary.targetWords, 9999,
              )
            : await generateSessionSummary(
                avatarId, worldTag, characterName,
                context.chat, context.chatId,
                settings.summary.prompt, settings.summary.targetWords, 9999,
              );

        if (summary) {
            lastSummaryGeneratedAt = Date.now();
            toastr.success('Story synopsis saved.');
            updateMemoryStatus().catch(() => {});
            if ($('.ms-tab[data-tab="summary"]').hasClass('active')) loadSummaryList();
        } else {
            toastr.error('Synopsis generation failed.');
        }
    } finally {
        isGeneratingSummary = false;
    }
}

async function mergeSummaries() {
    if (!currentWorldTag) { toastr.warning('No world tag detected.'); return; }
    const characterName = resolveCurrentCharName();
    if (!characterName) { toastr.warning('No character selected.'); return; }

    const avatarId = currentPersonaId || resolvePersonaId();
    const { persistentWorld } = getWorldSettings(currentWorldTag);

    const all = persistentWorld
        ? await getSharedSummaries(currentWorldTag, characterName, { limit: 1000 })
        : await getSummaries(avatarId, currentWorldTag, characterName, { limit: 1000 });

    if (!all?.length) { toastr.warning('No summaries to merge.'); return; }
    if (all.length < 2) { toastr.info('Only one summary exists — nothing to merge.'); return; }

    // Concatenate oldest → newest, no LLM involved
    const merged = all.map(s => s.summary).join('\n\n');

    try {
        const context = getContext();
        if (persistentWorld) {
            await clearSharedSummaries(currentWorldTag, characterName);
            await appendSharedSummary(currentWorldTag, characterName, { chatId: context.chatId, summary: merged, messageCount: context.chat.length });
        } else {
            await clearSummaries(avatarId, currentWorldTag, characterName);
            await appendSummary(avatarId, currentWorldTag, characterName, { chatId: context.chatId, summary: merged, messageCount: context.chat.length });
        }
        toastr.success(`${all.length} summaries merged.`);
        await loadSummaryList();
    } catch {
        toastr.error('Failed to merge summaries.');
    }
}

// ---------------------------------------------------------------------------
// UI — Settings panel
// ---------------------------------------------------------------------------

async function initSettingsPanel() {
    const extensionFolderPath = `third-party/${import.meta.url.split('/').at(-2)}`;
    const settingsHtml = await renderExtensionTemplateAsync(extensionFolderPath, 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettingsEvents();
    populateSettingsPanel();
    updatePersonaIndicator();
    updateBudgetDisplay();
    updateMemoryStatus().catch(() => {});
}

function updatePersonaIndicator() {
    const id = currentPersonaId || resolvePersonaId();
    $('#ms-active-persona-id').text(id || '(none)');
}

function checkLayerMinWarning(budget, minS, minE) {
    const exceeded = (minS + minE) > budget;
    $('#ms-min-budget-warning').toggleClass('hidden', !exceeded);
}

function updateAutoCounters() {
    const settings  = getSettings();
    const context   = getContext();
    const chatLen   = context.chat?.length || 0;

    // Extraction counter
    const exInterval = settings.extraction?.intervalMessages || 0;
    if (settings.extraction?.enabled && exInterval > 0) {
        const count = Math.min(chatLen - lastExtractionAtChatLength, exInterval);
        const pct   = (count / exInterval * 100).toFixed(1) + '%';
        $('#ms-counter-extraction').text(`${count} / ${exInterval}`);
        $('#ms-counter-bar-extraction').css('width', pct);
    } else {
        $('#ms-counter-extraction').text('Off');
        $('#ms-counter-bar-extraction').css('width', '0%');
    }

    // Summary counter
    const sumInterval = settings.summary?.autoIntervalMessages || 0;
    if (sumInterval > 0) {
        const count = Math.min(chatLen - lastSummaryAtChatLength, sumInterval);
        const pct   = (count / sumInterval * 100).toFixed(1) + '%';
        $('#ms-counter-summary').text(`${count} / ${sumInterval}`);
        $('#ms-counter-bar-summary').css('width', pct);
    } else {
        $('#ms-counter-summary').text('Off');
        $('#ms-counter-bar-summary').css('width', '0%');
    }
}

function updateBudgetDisplay() {
    const budget = getSettings().contextBudgetTokens ?? 1200;
    $('#ms-budget-token-display').text(`${budget.toLocaleString()} tokens`);

    const bd = lastInjectionBreakdown;
    if (bd) {
        const pctOf = (n) => (Math.min(n || 0, budget) / budget * 100).toFixed(2) + '%';
        // Five bars — one per named memory category
        $('#ms-bar-identity').css('width',   pctOf(bd.profileTokens    || 0));
        $('#ms-bar-worldstate').css('width', pctOf(bd.worldStateTokens || 0));
        $('#ms-bar-char').css('width',       pctOf(bd.charTokens       || 0));
        $('#ms-bar-summary').css('width',    pctOf(bd.layer2           || 0));
        $('#ms-bar-events').css('width',     pctOf(bd.layer3           || 0));

        const fmt = (n) => (n > 0) ? `${n.toLocaleString()} tk` : '—';
        $('#ms-breakdown-profile').text(`Your Active Persona: ${fmt(bd.profileTokens    || 0)}`);
        $('#ms-breakdown-worldstate').text(`World State: ${fmt(bd.worldStateTokens || 0)}`);
        $('#ms-breakdown-char').text(`Character: ${fmt(bd.charTokens         || 0)}`);
        $('#ms-breakdown-l2').text(`Story So Far: ${fmt(bd.layer2             || 0)}`);
        $('#ms-breakdown-l3').text(`Memories: ${fmt(bd.layer3                 || 0)}`);
        $('#ms-breakdown-total').text(`${bd.used.toLocaleString()} / ${budget.toLocaleString()} tk`);

        $('#ms-budget-breakdown').removeClass('hidden');
    } else {
        $('#ms-budget-breakdown').addClass('hidden');
    }
}

function renderInjectionPreview(bd) {
    const $preview = $('#ms-injection-preview');
    if (!$preview.length) return;

    if (!bd || (!bd.profileText && !bd.worldStateText && !bd.charText && !bd.layer2Text && !bd.layer3Text)) {
        $preview.html('<p class="ms-hint" style="padding:4px 0;">Nothing injected — no world tag matched, or all layers are empty. Check the <strong>Worlds</strong> tab to verify the world tag for this character.</p>');
        return;
    }

    // Five named layers — one per tab, each showing what was actually injected
    const layers = [
        { text: bd.profileText,    tokens: bd.profileTokens    || 0, label: 'Your Active Persona', color: '#3498db' },
        { text: bd.worldStateText, tokens: bd.worldStateTokens || 0, label: 'World State',  color: '#f39c12' },
        { text: bd.charText,       tokens: bd.charTokens       || 0, label: 'Character',    color: '#9b59b6' },
        { text: bd.layer2Text,     tokens: bd.layer2           || 0, label: 'Story So Far', color: '#2ecc71' },
        { text: bd.layer3Text,     tokens: bd.layer3           || 0, label: 'Memories',     color: '#e67e22' },
    ];

    const total  = bd.used ?? (bd.layer1 + bd.layer2 + bd.layer3);
    const budget = bd.budget ?? getSettings().contextBudgetTokens ?? 1200;

    // Summary pill row — only for layers that contributed something
    const parts = layers
        .filter(l => l.text && l.tokens > 0)
        .map(l => `<span style="color:${l.color}">${l.label} ${l.tokens.toLocaleString()}</span>`)
        .join('<span class="ms-hint"> · </span>');

    let html = `
        <div class="ms-preview-totals">
            <span class="ms-preview-total-used"><strong>${total.toLocaleString()} tk</strong> injected</span>
            <span class="ms-preview-total-budget ms-hint">of ${budget.toLocaleString()} tk budget</span>
            ${parts ? `<span class="ms-preview-total-breakdown">${parts}</span>` : ''}
        </div>`;

    for (const layer of layers) {
        if (!layer.text) continue;
        html += `
            <div class="ms-preview-layer">
                <div class="ms-preview-layer-header" style="border-left-color:${layer.color}">
                    <span class="ms-preview-layer-label">${layer.label}</span>
                    <span class="ms-hint" style="margin:0;">${layer.tokens.toLocaleString()} tk</span>
                    <span class="ms-preview-toggle">▶</span>
                </div>
                <pre class="ms-preview-text hidden">${escHtmlUtil(layer.text)}</pre>
            </div>`;
    }

    $preview.html(html);
}

function updateStatusBadge() {
    if (getSettings().enabled) {
        $('#ms-status-badge').text('ON').removeClass('ms-badge-off').addClass('ms-badge-on');
    } else {
        $('#ms-status-badge').text('OFF').removeClass('ms-badge-on').addClass('ms-badge-off');
    }
}

async function updateMemoryStatus() {
    updateStatusBadge();
    updatePersistentWorldStatusToggle();
    const settings = getSettings();

    if (!settings.enabled) {
        $('#ms-memory-status').text('Disabled');
        return;
    }

    const context = getContext();
    const characterName = context.name2;
    const avatarId = currentPersonaId || resolvePersonaId();

    if (!characterName) {
        if (context.groupId && currentWorldTag) {
            const group = (context.groups || []).find(g => g.id === context.groupId);
            const taggedCount = (group?.members || [])
                .filter(av => {
                    const n = (context.characters || []).find(c => c.avatar === av)?.name;
                    return n && detectWorldTagForCharName(n);
                }).length;
            $('#ms-memory-status').text(`[${currentWorldTag}] Group: ${taggedCount} tagged member${taggedCount !== 1 ? 's' : ''}`);
        } else {
            $('#ms-memory-status').text('No character loaded');
        }
        return;
    }

    if (!currentWorldTag) {
        $('#ms-memory-status')
            .text(`${characterName}: no world tag — add one in Worlds settings`);
        return;
    }

    try {
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        const [events, summaries, identity, sharedWorld] = await Promise.all([
            persistentWorld
                ? getSharedEvents(currentWorldTag, characterName, { limit: 1000 })
                : getEvents(avatarId, currentWorldTag, characterName, { limit: 1000 }),
            persistentWorld
                ? getSharedSummaries(currentWorldTag, characterName, { limit: 1000 })
                : getSummaries(avatarId, currentWorldTag, characterName, { limit: 1000 }),
            loadIdentity(avatarId, currentWorldTag, null),
            persistentWorld
                ? loadSharedWorldState(currentWorldTag).catch(() => null)
                : Promise.resolve(null),
        ]);

        const worldFactCount = persistentWorld
            ? (sharedWorld?.worldFacts?.length || 0)
            : (identity.worldFacts?.length || 0);

        const factCount =
            (identity.titles?.length || 0) +
            (identity.factions?.length || 0) +
            (identity.relationships?.length || 0) +
            worldFactCount +
            Object.keys(identity.custom || {}).length;

        const parts = [];
        if (factCount > 0)       parts.push(`${factCount} fact${factCount !== 1 ? 's' : ''}`);
        if (summaries.length > 0) parts.push(`${summaries.length} summar${summaries.length !== 1 ? 'ies' : 'y'}`);
        if (events.length > 0)   parts.push(`${events.length} memor${events.length !== 1 ? 'ies' : 'y'}`);

        const worldLabel = `[${currentWorldTag}]`;
        $('#ms-memory-status').text(
            parts.length > 0
                ? `${worldLabel} ${characterName}: ${parts.join(' · ')}`
                : `${worldLabel} ${characterName}: no memory yet`
        );
    } catch {
        $('#ms-memory-status').text(`${characterName}: ready`);
    }
}

function summaryIntervalLabel(val) {
    return val === 0 ? 'Off' : `every ${val} messages`;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

function updateHealthChecks() {
    const context   = getContext();
    const personaId = currentPersonaId || resolvePersonaId();
    const worldTag  = currentWorldTag;
    const charName  = context.name2;

    // Check 1: persona
    const personaOk = !!(personaId && personaId !== 'default');
    setHealthRow('ms-health-persona', personaOk,
        personaOk ? personaId : 'No persona selected — pick one in the Persona panel');

    // Check 2: world tag
    const worldOk = !!worldTag;
    setHealthRow('ms-health-world', worldOk,
        worldOk ? worldTag : 'No world tag active — add one in Worlds tab and tag the character card');

    // Check 3: character in active world
    if (context.groupId) {
        // Group chat: context.name2 is null until generation fires.
        // Instead, find all group members that carry the world tag.
        const group = (context.groups || []).find(g => g.id === context.groupId);
        const taggedMembers = (group?.members || [])
            .map(av => (context.characters || []).find(c => c.avatar === av)?.name)
            .filter(name => name && detectWorldTagForCharName(name));
        const charOk = taggedMembers.length > 0 && !!worldTag;
        setHealthRow('ms-health-character', charOk,
            charOk ? taggedMembers.join(', ') : 'No group member has a matching world tag');
    } else {
        const charOk = !!(charName && worldTag);
        setHealthRow('ms-health-character', charOk,
            charOk ? charName : 'No character with matching world tag in this chat');
    }
}

function setHealthRow(id, pass, label) {
    const $row = $(`#${id}`);
    $row.toggleClass('pass', pass).toggleClass('fail', !pass);
    $row.find('.ms-health-icon').text(pass ? '✓' : '✗');
    $row.find('.ms-health-value').text(label);
}

// ---------------------------------------------------------------------------
// Overview / "What does the AI know?" audit view
// ---------------------------------------------------------------------------

async function loadAuditView() {
    const context       = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId      = currentPersonaId || resolvePersonaId();
    const worldTag      = currentWorldTag;

    const $label   = $('#ms-overview-char-label');
    const $content = $('#ms-overview-content');

    if (!characterName || !worldTag) {
        $label.text('Character: —');
        $content.html('<p class="ms-hint" style="padding:4px 0;">No character or world tag active. Start a chat to see memory state.</p>');
        return;
    }

    $label.text(`${worldTag} — ${characterName}`);
    $content.html('<p class="ms-hint" style="padding:4px 0;">Loading…</p>');

    try {
        const { persistentWorld } = getWorldSettings(worldTag);

        const [identity, charIdentity, sharedWorldState, summaries, events] = await Promise.all([
            loadIdentity(avatarId, worldTag, null),
            persistentWorld
                ? loadSharedCharKnowledge(worldTag, characterName).catch(() => emptyIdentity())
                : loadIdentity(avatarId, worldTag, characterName).catch(() => emptyIdentity()),
            persistentWorld
                ? loadSharedWorldState(worldTag).catch(() => emptyIdentity())
                : Promise.resolve(null),
            persistentWorld
                ? getSharedSummaries(worldTag, characterName, { limit: 1000 })
                : getSummaries(avatarId, worldTag, characterName, { limit: 1000 }),
            persistentWorld
                ? getSharedEvents(worldTag, characterName, { limit: 1000 })
                : getEvents(avatarId, worldTag, characterName, { limit: 1000 }),
        ]);
        const worldIdentity = persistentWorld ? sharedWorldState : { worldFacts: identity.worldFacts || [] };

        let html = '';

        // ── Stats bar ─────────────────────────────────────────────────
        const personaFactCount =
            (identity.titles?.length || 0) +
            (identity.factions?.length || 0) +
            (identity.relationships?.length || 0) +
            Object.keys(identity.custom || {}).length;
        const charFactCount =
            (charIdentity.titles?.length || 0) +
            (charIdentity.factions?.length || 0) +
            (charIdentity.relationships?.length || 0);
        const worldFactCount = worldIdentity.worldFacts?.length || 0;
        const totalFactCount = personaFactCount + charFactCount + worldFactCount;

        html += `<div style="margin-bottom:10px;">
            <span class="ms-overview-stat">${totalFactCount} identity fact${totalFactCount !== 1 ? 's' : ''}</span>
            <span class="ms-overview-stat">${worldFactCount} world fact${worldFactCount !== 1 ? 's' : ''}</span>
            <span class="ms-overview-stat">${summaries.length} summar${summaries.length !== 1 ? 'ies' : 'y'}</span>
            <span class="ms-overview-stat">${events.length} memor${events.length !== 1 ? 'ies' : 'y'}</span>
        </div>`;

        // ── Persona Identity ──────────────────────────────────────────
        html += `<div class="ms-section-title ms-overview-section">Persona Identity</div>`;

        if ((identity.titles || []).length) {
            html += overviewField('Titles', identity.titles.join(', '));
        }
        if ((identity.factions || []).length) {
            const v = identity.factions.map(f => `${escHtmlUtil(f.name)}: ${escHtmlUtil(f.stance || '')}`).join('<br>');
            html += overviewField('Factions', v, true);
        }
        const repKeys = Object.keys(identity.reputation || {});
        if (repKeys.length) {
            const v = repKeys.map(k => `${escHtmlUtil(k)}: ${escHtmlUtil(identity.reputation[k])}`).join('<br>');
            html += overviewField('Reputation', v, true);
        }
        if ((identity.relationships || []).length) {
            const v = identity.relationships.map(r => `${escHtmlUtil(r.name)}: ${escHtmlUtil(r.type || '')}`).join('<br>');
            html += overviewField('Relationships', v, true);
        }
        const customKeys = Object.keys(identity.custom || {});
        if (customKeys.length) {
            const v = customKeys.map(k => `${escHtmlUtil(k)}: ${escHtmlUtil(String(identity.custom[k]))}`).join('<br>');
            html += overviewField('Custom', v, true);
        }
        if (!personaFactCount) {
            html += `<p class="ms-hint" style="padding:2px 0;">No profile data yet.</p>`;
        }

        // ── Character State ────────────────────────────────────────────
        html += `<div class="ms-section-title ms-overview-section" style="margin-top:14px; color:#9b59b6;">Character Knowledge — ${escHtmlUtil(characterName)}</div>`;
        if ((charIdentity.titles || []).length) {
            html += overviewField('Titles', charIdentity.titles.join(', '));
        }
        if ((charIdentity.factions || []).length) {
            const v = charIdentity.factions.map(f => `${escHtmlUtil(f.name)}: ${escHtmlUtil(f.stance || '')}`).join('<br>');
            html += overviewField('Factions', v, true);
        }
        const charRepKeys = Object.keys(charIdentity.reputation || {});
        if (charRepKeys.length) {
            const v = charRepKeys.map(k => `${escHtmlUtil(k)}: ${escHtmlUtil(charIdentity.reputation[k])}`).join('<br>');
            html += overviewField('Reputation', v, true);
        }
        if ((charIdentity.relationships || []).length) {
            const v = charIdentity.relationships.map(r => `${escHtmlUtil(r.name)}: ${escHtmlUtil(r.type || '')}`).join('<br>');
            html += overviewField('Relationships', v, true);
        }
        if (!charFactCount) {
            html += `<p class="ms-hint" style="padding:2px 0;">No character knowledge data yet.</p>`;
        }

        // ── World Facts ────────────────────────────────────────────────
        html += `<div class="ms-section-title ms-overview-section" style="margin-top:14px; color:#f39c12;">World State — ${escHtmlUtil(worldTag)}</div>`;
        if (worldFactCount) {
            const v = worldIdentity.worldFacts.map(f => `• ${escHtmlUtil(f.fact || '')}`).join('<br>');
            html += overviewField('Facts', v, true);
        } else {
            html += `<p class="ms-hint" style="padding:2px 0;">No world state saved yet.</p>`;
        }

        // ── Recent summaries ──────────────────────────────────────────
        html += `<div class="ms-section-title ms-overview-section" style="margin-top:14px;">Recent Summaries</div>`;
        if (summaries.length) {
            const recent = [...summaries].slice(-3).reverse();
            html += recent.map(s => {
                const date = s.ts ? `<span class="ms-overview-date">${new Date(s.ts).toLocaleDateString()} —</span>` : '';
                return `<div class="ms-overview-summary-item">${date}${escHtmlUtil(s.summary || '')}</div>`;
            }).join('');
        } else {
            html += `<p class="ms-hint" style="padding:2px 0;">No summaries yet.</p>`;
        }

        // ── Recent events ─────────────────────────────────────────────
        html += `<div class="ms-section-title ms-overview-section" style="margin-top:14px;">Recent Memories (last 10)</div>`;
        if (events.length) {
            const recent = events.slice(-10).reverse();
            html += recent.map(e => {
                const date = e.ts ? `<span class="ms-overview-date">${new Date(e.ts).toLocaleDateString()} —</span>` : '';
                return `<div class="ms-overview-event-item">${date}${escHtmlUtil(e.event || '')}</div>`;
            }).join('');
        } else {
            html += `<p class="ms-hint" style="padding:2px 0;">No memories logged yet.</p>`;
        }

        $content.html(html);
    } catch (err) {
        console.error('[PAC] loadAuditView error:', err);
        $content.html('<p class="ms-hint" style="padding:4px 0;">Failed to load memory snapshot.</p>');
    }
}

function overviewField(key, valHtml, rawHtml = false) {
    const val = rawHtml ? valHtml : escHtmlUtil(String(valHtml));
    return `<div class="ms-overview-field">
        <span class="ms-overview-key">${escHtmlUtil(key)}</span>
        <span class="ms-overview-val">${val}</span>
    </div>`;
}

function bindSettingsEvents() {
    // Tab switching
    $(document).on('click', '.ms-tab', function () {
        const tab   = $(this);
        const panel = tab.closest('.ms-settings-panel');
        const tabName = tab.data('tab');

        panel.find('.ms-tab').removeClass('active');
        panel.find('.ms-tab-content').addClass('hidden');
        tab.addClass('active');
        panel.find(`.ms-tab-content[data-tab="${tabName}"]`).removeClass('hidden');

        if (tabName === 'inject')     renderInjectionPreview(lastInjectionBreakdown);
        if (tabName === 'overview')   loadAuditView();
        if (tabName === 'identity') {
            $('#ms-identity-char-label').text(
                `Persona: ${currentPersonaId || resolvePersonaId() || '(none)'}` +
                (currentWorldTag ? ` · World: ${currentWorldTag}` : '')
            );
            loadIdentityIntoEditor();
        }
        if (tabName === 'character')  loadCharIdentityIntoForm();
        if (tabName === 'worldstate') loadWorldFactsDisplay();
        if (tabName === 'events')     loadEventLog();
        if (tabName === 'summary')    loadSummaryList();
        if (tabName === 'persona')    loadPersonaList();
        if (tabName === 'worlds')     loadWorldBrowser();
    });

    // Advanced panel toggle
    $(document).on('click', '#ms-advanced-toggle', function () {
        const $panel  = $('#ms-advanced-panel');
        const opening = $panel.hasClass('hidden');
        $panel.toggleClass('hidden');
        $('#ms-advanced-icon').text(opening ? '▼' : '▶');
    });

    // Master toggle
    $(document).on('change', '#ms-enabled', function () {
        getSettings().enabled = $(this).is(':checked');
        saveSettingsDebounced();
        updateMemoryStatus().catch(() => {});
    });

    // Budget slider (lives in General tab)
    $(document).on('input', '#ms-budget-slider', function () {
        const val = parseInt($(this).val()) || 1200;
        getSettings().contextBudgetTokens = val;
        saveSettingsDebounced();
        $('#ms-budget-slider-display').text(`${val.toLocaleString()} tk`);
        updateBudgetDisplay();  // updates #ms-budget-token-display in the budget card
        const s = getSettings().inject;
        checkLayerMinWarning(val, s.minSummary ?? 0, s.minEvents ?? 0);
    });

    // Per-layer minimum sliders (Story So Far and Memories only — always-injected layers have no slider)
    $(document).on('input', '#ms-min-summary', function () {
        const val = parseInt($(this).val()) || 0;
        getSettings().inject.minSummary = val;
        saveSettingsDebounced();
        $('#ms-min-summary-display').text(`${val} tk`);
        const s = getSettings(); checkLayerMinWarning(s.contextBudgetTokens ?? 1200, val, s.inject.minEvents ?? 0);
    });
    $(document).on('input', '#ms-min-events', function () {
        const val = parseInt($(this).val()) || 0;
        getSettings().inject.minEvents = val;
        saveSettingsDebounced();
        $('#ms-min-events-display').text(`${val} tk`);
        const s = getSettings(); checkLayerMinWarning(s.contextBudgetTokens ?? 1200, s.inject.minSummary ?? 0, val);
    });

    // Consolidation prompt in General tab
    $(document).on('input', '#ms-consolidation-prompt', function () {
        getSettings().consolidation.prompt = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on('click', '#ms-btn-reset-consolidation-prompt', () => {
        getSettings().consolidation.prompt = DEFAULT_CONSOLIDATION_PROMPT;
        $('#ms-consolidation-prompt').val(DEFAULT_CONSOLIDATION_PROMPT);
        saveSettingsDebounced();
        toastr.success('Consolidation prompt reset to default.');
    });

    // Extraction settings
    $(document).on('change', '#ms-extraction-enabled', function () {
        getSettings().extraction.enabled = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $(document).on('change', '#ms-extraction-approval', function () {
        getSettings().extraction.requireApproval = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $(document).on('input', '#ms-extraction-interval', function () {
        getSettings().extraction.intervalMessages = parseInt($(this).val()) || 5;
        saveSettingsDebounced();
    });
    $(document).on('input', '#ms-extraction-prompt', function () {
        getSettings().extraction.prompt = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on('click', '#ms-btn-reset-extraction-prompt', () => {
        getSettings().extraction.prompt = DEFAULT_EXTRACTION_PROMPT;
        $('#ms-extraction-prompt').val(DEFAULT_EXTRACTION_PROMPT);
        saveSettingsDebounced();
        toastr.success('Extraction prompt reset to default.');
    });
    $(document).on('click', '#ms-btn-trigger-extraction', () => {
        lastExtractionAtChatLength = getContext().chat?.length || 0;
        triggerExtractionForChat();
    });
    $(document).on('click', '#ms-btn-full-extraction', () => {
        lastExtractionAtChatLength = getContext().chat?.length || 0;
        triggerExtractionForChat({ fullHistory: true });
    });

    // Summary settings
    $(document).on('input', '#ms-summary-words', function () {
        getSettings().summary.targetWords = parseInt($(this).val()) || 200;
        saveSettingsDebounced();
    });
    $(document).on('input', '#ms-summary-interval', function () {
        const val = parseInt($(this).val()) || 0;
        getSettings().summary.autoIntervalMessages = val;
        lastSummaryAtChatLength = getContext().chat?.length || 0;
        $('#ms-summary-interval-display').text(summaryIntervalLabel(val));
        saveSettingsDebounced();
    });
    $(document).on('input', '#ms-summary-window', function () {
        getSettings().summary.summaryWindowMessages = parseInt($(this).val()) || 50;
        saveSettingsDebounced();
    });
    $(document).on('click', '#ms-btn-story-synopsis', () => generateStorySynopsis());
    $(document).on('click', '#ms-btn-merge-summaries', () => mergeSummaries());
    $(document).on('input', '#ms-summary-prompt', function () {
        getSettings().summary.prompt = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on('click', '#ms-btn-reset-summary-prompt', () => {
        getSettings().summary.prompt = DEFAULT_SUMMARY_PROMPT;
        $('#ms-summary-prompt').val(DEFAULT_SUMMARY_PROMPT);
        saveSettingsDebounced();
        toastr.success('Summary prompt reset to default.');
    });
    $(document).on('click', '#ms-btn-generate-summary', () => {
        // In group chats, generate for all tagged non-narrator members so every
        // character that might respond next has an up-to-date summary to inject.
        const ctx = getContext();
        if (ctx.groupId) {
            generateSummaryForChat();
        } else {
            generateSummaryForCurrentChar();
        }
    });

    // Overview tab
    $(document).on('click', '#ms-btn-refresh-overview', () => loadAuditView());

    // Injection preview layer expand/collapse
    $(document).on('click', '.ms-preview-layer-header', function () {
        const $text   = $(this).next('.ms-preview-text');
        const $toggle = $(this).find('.ms-preview-toggle');
        $text.toggleClass('hidden');
        $toggle.text($text.hasClass('hidden') ? '▶' : '▼');
    });

    // Event log viewer
    $(document).on('click', '#ms-btn-refresh-events', () => loadEventLog());
    $(document).on('click', '#ms-btn-clear-events', () => clearAllEvents());
    $(document).on('input', '#ms-event-search', function () { filterEventLog($(this).val()); });
    $(document).on('click', '#ms-btn-rebuild-vectors', () => rebuildVectorIndex());
    $(document).on('click', '#ms-btn-consolidate-events', () => triggerConsolidation());
    // Consolidation threshold slider
    $(document).on('input', '#ms-consolidation-threshold', function () {
        const v = parseInt($(this).val()) || 0;
        $('#ms-consolidation-threshold-display').text(v === 0 ? 'never' : `${v} memories`);
        getSettings().consolidation.autoThreshold = v;
        saveSettingsDebounced();
    });
    // Events advanced sub-toggle (hides the Rebuild Vector Index power-user section)
    $(document).on('click', '#ms-events-advanced-toggle', function () {
        $('#ms-events-advanced-panel').toggleClass('hidden');
    });
    $(document).on('click', '#ms-btn-add-event', () => addManualEvent());
    $(document).on('click', '#ms-events-list .ms-viewer-delete', function () {
        const index = parseInt($(this).data('index'));
        if (!isNaN(index)) deleteEventEntry(index);
    });
    // Memory inline edit — enter edit mode
    $(document).on('click', '#ms-events-list .ms-viewer-edit', function (e) {
        e.stopPropagation();
        const $item = $(this).closest('.ms-viewer-item');
        if ($item.hasClass('editing')) return;
        const currentText = $item.find('.ms-viewer-text').text();
        $item.addClass('editing');
        $item.find('.ms-viewer-edit').hide();
        const $actions = $(`
            <div class="ms-event-edit-actions">
                <button class="ms-event-edit-btn save" data-index="${$(this).data('index')}">Save</button>
                <button class="ms-event-edit-btn cancel">Cancel</button>
            </div>`);
        const $area = $(`<textarea class="ms-event-edit-area"></textarea>`).val(currentText);
        $item.append($area).append($actions);
        $area.focus();
    });
    // Memory edit — save
    $(document).on('click', '#ms-events-list .ms-event-edit-btn.save', async function (e) {
        e.stopPropagation();
        const $item   = $(this).closest('.ms-viewer-item');
        const index   = parseInt($(this).data('index'));
        const newText = $item.find('.ms-event-edit-area').val().trim();
        if (!newText) { toastr.warning('Memory text cannot be empty.'); return; }
        const characterName = resolveCurrentCharName();
        if (!characterName || !currentWorldTag) { toastr.warning('No character/world active.'); return; }
        const avatarId = currentPersonaId || resolvePersonaId();
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        try {
            if (persistentWorld) {
                await updateSharedEvent(currentWorldTag, characterName, index, newText);
            } else {
                await updateEvent(avatarId, currentWorldTag, characterName, index, newText);
            }
            toastr.success('Memory updated.');
            await loadEventLog();
        } catch {
            toastr.error('Failed to save memory.');
        }
    });
    // Memory edit — cancel
    $(document).on('click', '#ms-events-list .ms-event-edit-btn.cancel', function (e) {
        e.stopPropagation();
        const $item = $(this).closest('.ms-viewer-item');
        $item.removeClass('editing');
        $item.find('.ms-event-edit-area, .ms-event-edit-actions').remove();
        $item.find('.ms-viewer-edit').show();
    });

    // Summary viewer
    $(document).on('click', '#ms-btn-refresh-summaries', () => loadSummaryList());
    $(document).on('click', '#ms-btn-clear-summaries', () => clearAllSummaries());
    $(document).on('click', '#ms-summaries-list .ms-summary-header', function (e) {
        // Don't expand/collapse if clicking action buttons
        if ($(e.target).closest('.ms-viewer-delete, .ms-summary-edit-btn').length) return;
        const $item   = $(this).closest('.ms-summary-item');
        if ($item.hasClass('editing')) return; // ignore expand when in edit mode
        const $body   = $item.find('.ms-summary-body');
        const $toggle = $(this).find('.ms-summary-toggle');
        $body.toggleClass('expanded');
        $toggle.text($body.hasClass('expanded') ? '▼' : '▶');
    });
    $(document).on('click', '#ms-summaries-list .ms-summary-delete', function (e) {
        e.stopPropagation();
        const index = parseInt($(this).data('index'));
        if (!isNaN(index)) deleteSummaryEntry(index);
    });
    // Summary inline edit — enter edit mode
    $(document).on('click', '#ms-summaries-list .ms-summary-edit', function (e) {
        e.stopPropagation();
        const $item = $(this).closest('.ms-summary-item');
        if ($item.hasClass('editing')) return;
        const currentText = $item.find('.ms-summary-body').text();
        $item.addClass('editing');
        $item.find('.ms-summary-edit').hide();
        const $actions = $(`
            <div class="ms-summary-edit-actions">
                <button class="ms-summary-edit-btn save" data-index="${$(this).data('index')}">Save</button>
                <button class="ms-summary-edit-btn cancel">Cancel</button>
            </div>`);
        const $area = $(`<textarea class="ms-summary-edit-area"></textarea>`).val(currentText);
        $item.append($area).append($actions);
        $area.focus();
    });
    // Summary save
    $(document).on('click', '#ms-summaries-list .ms-summary-edit-btn.save', async function (e) {
        e.stopPropagation();
        const $item  = $(this).closest('.ms-summary-item');
        const index  = parseInt($(this).data('index'));
        const newText = $item.find('.ms-summary-edit-area').val().trim();
        if (!newText) { toastr.warning('Summary text cannot be empty.'); return; }
        const charName = resolveCurrentCharName();
        if (!charName || !currentWorldTag) { toastr.warning('No character/world active.'); return; }
        const avatarId = currentPersonaId || resolvePersonaId();
        const { persistentWorld: pwUpdate } = getWorldSettings(currentWorldTag);
        try {
            if (pwUpdate) {
                await updateSharedSummary(currentWorldTag, charName, index, newText);
            } else {
                await updateSummary(avatarId, currentWorldTag, charName, index, newText);
            }
            toastr.success('Summary updated.');
            await loadSummaryList();
        } catch {
            toastr.error('Failed to save summary.');
        }
    });
    // Summary cancel edit
    $(document).on('click', '#ms-summaries-list .ms-summary-edit-btn.cancel', function (e) {
        e.stopPropagation();
        const $item = $(this).closest('.ms-summary-item');
        $item.removeClass('editing');
        $item.find('.ms-summary-edit-area, .ms-summary-edit-actions').remove();
        $item.find('.ms-summary-edit').show();
    });

    // Identity editor
    $(document).on('click', '#ms-btn-load-identity', () => loadIdentityIntoEditor());
    $(document).on('click', '#ms-btn-save-identity', () => saveIdentityFromEditor());
    $(document).on('click', '#ms-btn-reset-identity', () => resetIdentity());

    // Character State — Load / Save / Reset
    $(document).on('click', '#ms-btn-load-char-identity',  () => loadCharIdentityIntoForm());
    $(document).on('click', '#ms-btn-save-char-identity',  () => saveCharIdentityFromForm());
    $(document).on('click', '#ms-btn-reset-char-identity', () => resetCharIdentity());

    // Character State — title chip add
    $(document).on('click', '#ms-btn-add-char-title', () => {
        const val = $('#ms-char-identity-title-input').val().trim();
        if (!val) return;
        $('#ms-char-identity-titles').append(makeChip(val));
        $('#ms-char-identity-title-input').val('');
    });
    $(document).on('keydown', '#ms-char-identity-title-input', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#ms-btn-add-char-title').trigger('click'); }
    });

    // Character State — table row adds
    $(document).on('click', '#ms-btn-add-char-faction',      () => $('#ms-char-identity-factions').append(makeTableRow(['', ''], 'char-factions')));
    $(document).on('click', '#ms-btn-add-char-reputation',   () => $('#ms-char-identity-reputation').append(makeTableRow(['', ''], 'char-reputation')));
    $(document).on('click', '#ms-btn-add-char-relationship', () => $('#ms-char-identity-relationships').append(makeTableRow(['', ''], 'char-relationships')));

    // World Facts — add fact manually
    $(document).on('click', '#ms-btn-add-worldfact', async function () {
        const text = $('#ms-worldfact-manual-input').val().trim();
        if (!text) return;
        if (!currentWorldTag) { toastr.warning('No world tag active.'); return; }
        try {
            const { persistentWorld } = getWorldSettings(currentWorldTag);
            const avatarId = currentPersonaId || resolvePersonaId();
            const worldIdentity = persistentWorld
                ? await loadSharedWorldState(currentWorldTag)
                : await loadIdentity(avatarId, currentWorldTag, null);
            const existingKeys = new Set(worldIdentity.worldFacts.map(w => (w.fact || '').toLowerCase()));
            if (existingKeys.has(text.toLowerCase())) {
                toastr.warning('This fact is already in the world state.');
                return;
            }
            worldIdentity.worldFacts.push({ fact: text, ts: Date.now(), chatId: '' });
            if (persistentWorld) {
                await storeSharedWorldState(currentWorldTag, worldIdentity);
            } else {
                await storeIdentity(avatarId, currentWorldTag, worldIdentity, null);
            }
            $('#ms-worldfact-manual-input').val('');
            renderWorldFactsList(worldIdentity.worldFacts);
            toastr.success('World fact added.');
        } catch (err) { toastr.error('Failed to add world fact.'); }
    });
    $(document).on('keydown', '#ms-worldfact-manual-input', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#ms-btn-add-worldfact').trigger('click'); }
    });

    // World Facts — delete individual fact
    $(document).on('click', '.ms-worldfact-world-delete', async function () {
        if (!currentWorldTag) return;
        const index = parseInt($(this).data('index'), 10);
        try {
            const { persistentWorld } = getWorldSettings(currentWorldTag);
            const avatarId = currentPersonaId || resolvePersonaId();
            const worldIdentity = persistentWorld
                ? await loadSharedWorldState(currentWorldTag)
                : await loadIdentity(avatarId, currentWorldTag, null);
            worldIdentity.worldFacts.splice(index, 1);
            if (persistentWorld) {
                await storeSharedWorldState(currentWorldTag, worldIdentity);
            } else {
                await storeIdentity(avatarId, currentWorldTag, worldIdentity, null);
            }
            renderWorldFactsList(worldIdentity.worldFacts);
        } catch (err) { toastr.error('Delete failed.'); }
    });

    // World Facts — inline edit — enter edit mode
    $(document).on('click', '.ms-worldfact-edit', function (e) {
        e.stopPropagation();
        const $row = $(this).closest('.ms-worldfact-row');
        if ($row.hasClass('editing')) return;
        const currentText = $row.data('fact');
        $row.addClass('editing');
        const $area = $(`<textarea class="ms-event-edit-area"></textarea>`).val(currentText);
        const $actions = $(`
            <div class="ms-worldfact-edit-actions">
                <button class="ms-worldfact-edit-btn save">Save</button>
                <button class="ms-worldfact-edit-btn cancel">Cancel</button>
            </div>`);
        $row.append($area).append($actions);
        $area.focus();
    });
    // World Facts — inline edit — save
    $(document).on('click', '.ms-worldfact-edit-btn.save', async function (e) {
        e.stopPropagation();
        const $row = $(this).closest('.ms-worldfact-row');
        const index = parseInt($row.data('index'), 10);
        const newText = $row.find('.ms-event-edit-area').val().trim();
        if (!newText) { toastr.warning('World fact cannot be empty.'); return; }
        if (!currentWorldTag) { toastr.warning('No world active.'); return; }
        try {
            const { persistentWorld } = getWorldSettings(currentWorldTag);
            const avatarId = currentPersonaId || resolvePersonaId();
            const worldIdentity = persistentWorld
                ? await loadSharedWorldState(currentWorldTag)
                : await loadIdentity(avatarId, currentWorldTag, null);
            worldIdentity.worldFacts[index].fact = newText;
            if (persistentWorld) {
                await storeSharedWorldState(currentWorldTag, worldIdentity);
            } else {
                await storeIdentity(avatarId, currentWorldTag, worldIdentity, null);
            }
            toastr.success('World fact updated.');
            renderWorldFactsList(worldIdentity.worldFacts);
        } catch { toastr.error('Failed to save world fact.'); }
    });
    // World Facts — inline edit — cancel
    $(document).on('click', '.ms-worldfact-edit-btn.cancel', function (e) {
        e.stopPropagation();
        const $row = $(this).closest('.ms-worldfact-row');
        $row.removeClass('editing');
        $row.find('.ms-event-edit-area, .ms-worldfact-edit-actions').remove();
    });

    // World Facts — clear all
    $(document).on('click', '#ms-btn-clear-worldfacts', async function () {
        if (!currentWorldTag) return;
        if (!confirm(`Clear all world state for "${currentWorldTag}"? This cannot be undone.`)) return;
        try {
            const { persistentWorld } = getWorldSettings(currentWorldTag);
            const avatarId = currentPersonaId || resolvePersonaId();
            if (persistentWorld) {
                const worldIdentity = await loadSharedWorldState(currentWorldTag);
                worldIdentity.worldFacts = [];
                await storeSharedWorldState(currentWorldTag, worldIdentity);
            } else {
                const worldIdentity = await loadIdentity(avatarId, currentWorldTag, null);
                worldIdentity.worldFacts = [];
                await storeIdentity(avatarId, currentWorldTag, worldIdentity, null);
            }
            renderWorldFactsList([]);
            toastr.success('World state cleared.');
        } catch (err) { toastr.error('Clear failed.'); }
    });

    // Identity view toggle (Form / JSON)
    $(document).on('click', '.ms-identity-view-btn', function () {
        const view = $(this).data('view');
        $('.ms-identity-view-btn').removeClass('active');
        $(this).addClass('active');
        if (view === 'form') {
            $('#ms-identity-form').removeClass('hidden');
            $('#ms-identity-json-view').addClass('hidden');
            // Sync JSON → form if switching to form
            try {
                const jsonVal = $('#ms-identity-editor').val().trim();
                if (jsonVal) renderIdentityForm(JSON.parse(jsonVal));
            } catch { /* keep current form state */ }
        } else {
            $('#ms-identity-json-view').removeClass('hidden');
            $('#ms-identity-form').addClass('hidden');
            // Sync form → JSON if switching to JSON
            try {
                $('#ms-identity-editor').val(JSON.stringify(readIdentityFromForm(), null, 2));
            } catch { /* keep current JSON */ }
        }
    });

    // Titles: add on button click or Enter key
    $(document).on('click', '#ms-btn-add-title', addTitleFromInput);
    $(document).on('keydown', '#ms-identity-title-input', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addTitleFromInput(); }
    });
    $(document).on('click', '.ms-chip-remove', function () {
        $(this).closest('.ms-chip').remove();
    });

    // Factions: add row
    $(document).on('click', '#ms-btn-add-faction', () => {
        $('#ms-identity-factions').append(makeTableRow(['', ''], 'factions'));
    });
    // Reputation: add row
    $(document).on('click', '#ms-btn-add-reputation', () => {
        $('#ms-identity-reputation').append(makeTableRow(['', ''], 'reputation'));
    });
    // Relationships: add row
    $(document).on('click', '#ms-btn-add-relationship', () => {
        $('#ms-identity-relationships').append(makeTableRow(['', ''], 'relationships'));
    });
    // Generic table row delete
    $(document).on('click', '.ms-identity-table .ms-row-delete', function () {
        $(this).closest('tr').remove();
    });

    // World facts: delete
    $(document).on('click', '.ms-worldfact-delete', function () {
        $(this).closest('.ms-worldfact-row').remove();
    });

    // Custom fields: add
    $(document).on('click', '#ms-btn-add-custom-field', () => {
        const key = $('#ms-identity-custom-key-input').val().trim();
        if (!key) return;
        // Sanitize: must start and end with a word char or hyphen; spaces allowed only in the middle.
        // Rejects names with special characters, or names that would be whitespace-only.
        if (!/^[\w-]([\w\s-]*[\w-])?$/.test(key)) {
            toastr.warning('Field name must start and end with a letter, number, or hyphen. Spaces are allowed in the middle.');
            return;
        }
        if ($(`#ms-identity-custom .ms-custom-field-row[data-key="${CSS.escape(key)}"]`).length) {
            toastr.warning(`Field "${key}" already exists.`);
            return;
        }
        $('#ms-identity-custom-key-input').val('');
        // Save to settings so it persists across loads
        const s = getSettings();
        s.customIdentityFields = s.customIdentityFields || [];
        if (!s.customIdentityFields.includes(key)) {
            s.customIdentityFields.push(key);
            saveSettingsDebounced();
        }
        $('#ms-identity-custom').append(`
            <div class="ms-custom-field-row" data-key="${escHtmlUtil(key)}">
                <span class="ms-custom-field-label">${escHtmlUtil(key)}</span>
                <input type="text" class="ms-custom-field-value" data-key="${escHtmlUtil(key)}" value="" placeholder="value…">
                <button class="ms-row-delete ms-custom-field-delete" data-key="${escHtmlUtil(key)}" title="Remove field">✕</button>
            </div>`);
    });

    // Custom fields: delete
    $(document).on('click', '.ms-custom-field-delete', function () {
        const key = $(this).data('key');
        $(this).closest('.ms-custom-field-row').remove();
        // Remove from settings definition
        const s = getSettings();
        s.customIdentityFields = (s.customIdentityFields || []).filter(k => k !== key);
        saveSettingsDebounced();
    });

    // Enter on custom field key input
    $(document).on('keydown', '#ms-identity-custom-key-input', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#ms-btn-add-custom-field').trigger('click'); }
    });

    // World tag list editor
    $(document).on('input', '#ms-world-tags-editor', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(Boolean);
        getSettings().worldTags = lines;
        saveSettingsDebounced();
        // Re-detect the world tag for the current character — a newly added tag may activate
        // the extension, or a removed tag may deactivate it, without requiring a chat reload.
        currentWorldTag = detectWorldTag();
        updateMemoryStatus().catch(() => {});
        updateHealthChecks();
    });
    $(document).on('click', '#ms-btn-reset-world-tags', () => {
        getSettings().worldTags = [...BUILTIN_WORLD_TAGS];
        $('#ms-world-tags-editor').val(BUILTIN_WORLD_TAGS.join('\n'));
        saveSettingsDebounced();
        toastr.success('World tags reset to built-in list.');
    });

    // World browser — Persistent World toggle (per-world rows)
    $(document).on('change', '.ms-persistent-world-toggle', async function () {
        await confirmAndSetPersistentWorld($(this).data('world'), $(this).is(':checked'), $(this));
    });

    // Status row — Persistent World toggle (current world shortcut)
    $(document).on('change', '#ms-pw-status-toggle', async function () {
        if (!currentWorldTag) return;
        const saved = await confirmAndSetPersistentWorld(currentWorldTag, $(this).is(':checked'), $(this));
        if (saved) loadWorldBrowser();
    });

    // World browser — delete world
    $(document).on('click', '.ms-world-delete', async function () {
        const worldTag = $(this).data('world');
        const avatarId = currentPersonaId || resolvePersonaId();
        if (!confirm(`Delete ALL memory data for world "${worldTag}"? This cannot be undone.`)) return;
        try {
            await deleteWorld(avatarId, worldTag);
            invalidateAllCaches(avatarId);
            toastr.success(`World "${worldTag}" data deleted.`);
            loadWorldBrowser();
            updateMemoryStatus().catch(() => {});
        } catch (err) {
            toastr.error('Failed to delete world data.');
        }
    });

    // World browser — view character events
    $(document).on('click', '.ms-char-view-events', async function (e) {
        e.stopPropagation();
        const worldTag = $(this).data('world');
        const charName = $(this).data('char');
        // Switch to Events tab and load for the selected character
        $('.ms-tab').removeClass('active');
        $('.ms-tab[data-tab="events"]').addClass('active');
        $('.ms-tab-content').addClass('hidden');
        $('.ms-tab-content[data-tab="events"]').removeClass('hidden');
        await loadEventLog(worldTag, charName);
    });

    // World browser — delete character data
    $(document).on('click', '.ms-char-delete', async function (e) {
        e.stopPropagation();
        const worldTag = $(this).data('world');
        const charName = $(this).data('char');
        const avatarId = currentPersonaId || resolvePersonaId();
        if (!confirm(`Delete ALL memory for "${charName}" in world "${worldTag}"? This cannot be undone.`)) return;
        try {
            await deleteCharData(avatarId, worldTag, charName);
            invalidateAllCaches(avatarId);
            toastr.success(`Memory for "${charName}" deleted.`);
            loadWorldBrowser();
        } catch (err) {
            toastr.error('Failed to delete character data.');
        }
    });

    // World browser — expand/collapse
    $(document).on('click', '.ms-world-header', function (e) {
        if ($(e.target).closest('.ms-world-controls').length) return;
        const $item = $(this).closest('.ms-world-item');
        const $chars = $item.find('.ms-world-chars');
        const $icon  = $(this).find('.ms-world-toggle');
        const expanding = $chars.hasClass('hidden');
        $chars.toggleClass('hidden');
        $icon.text(expanding ? '▼' : '▶');
    });

    // Persona tab
    $(document).on('click', '#ms-btn-delete-persona', () => deleteCurrentPersonaData());

    // Export persona memory
    $(document).on('click', '#ms-btn-export-persona', async () => {
        const avatarId = currentPersonaId || resolvePersonaId();
        try {
            const bundle = await exportPersona(avatarId);
            const blob   = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
            const url    = URL.createObjectURL(blob);
            const a      = document.createElement('a');
            a.href     = url;
            a.download = `pac-${avatarId.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toastr.success('Memory exported.');
        } catch (err) {
            toastr.error('Export failed.');
            console.error('[PAC] export error:', err);
        }
    });

    // Import persona memory
    $(document).on('click', '#ms-btn-import-persona', () => $('#ms-import-file').val('').trigger('click'));
    $(document).on('change', '#ms-import-file', async function () {
        const file = this.files?.[0];
        if (!file) return;
        const overwrite = $('#ms-import-overwrite').is(':checked');
        const avatarId  = currentPersonaId || resolvePersonaId();
        let bundle;
        try {
            bundle = JSON.parse(await file.text());
        } catch {
            toastr.error('Import failed — file is not valid JSON.');
            return;
        }

        // Preview: count what's in the bundle before committing
        const worldCount  = Object.keys(bundle.worlds  || {}).length;
        const eventCount  = Object.values(bundle.events  || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        const summaryCount = Object.values(bundle.summaries || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        const hasIdentity = Object.keys(bundle.identity || {}).length > 0;
        const overwriteWarning = overwrite
            ? '<p style="color:var(--SmartThemeQuoteColor,#e67e22); margin-top:8px;">⚠ <strong>Overwrite</strong> is enabled — existing files will be replaced.</p>'
            : '';

        const confirmed = await new Promise(resolve => {
            let settled = false;
            $(`<div>
                <p class="ms-hint" style="margin-bottom:8px;">The following data will be imported for persona <strong>${escHtmlUtil(avatarId)}</strong>:</p>
                <ul style="margin:0 0 8px 16px; padding:0;">
                    <li>${worldCount} world${worldCount !== 1 ? 's' : ''}</li>
                    <li>${eventCount} memor${eventCount !== 1 ? 'ies' : 'y'}</li>
                    <li>${summaryCount} summar${summaryCount !== 1 ? 'ies' : 'y'}</li>
                    ${hasIdentity ? '<li>Identity data</li>' : ''}
                </ul>
                ${overwriteWarning}
            </div>`).dialog({
                title: 'PAC — Confirm Import',
                width: 400,
                modal: true,
                buttons: {
                    'Import': function () { settled = true; $(this).dialog('close'); resolve(true); },
                    'Cancel': function () { settled = true; $(this).dialog('close'); resolve(false); },
                },
                close: function () { if (!settled) resolve(false); },
            });
        });

        if (!confirmed) return;

        try {
            const result = await importPersona(avatarId, bundle, overwrite);
            invalidateAllCaches(avatarId);
            toastr.success(`Import complete — ${result.filesWritten} file${result.filesWritten !== 1 ? 's' : ''} written.`);
            loadWorldBrowser();
        } catch (err) {
            toastr.error('Import failed — check the file is a valid PAC export.');
            console.error('[PAC] import error:', err);
        }
    });
}

function populateSettingsPanel() {
    const s = getSettings();
    const summaryInterval = s.summary.autoIntervalMessages || 0;

    $('#ms-enabled').prop('checked', s.enabled);
    $('#ms-extraction-enabled').prop('checked', s.extraction.enabled);
    $('#ms-extraction-approval').prop('checked', s.extraction.requireApproval);
    $('#ms-extraction-interval').val(s.extraction.intervalMessages);
    $('#ms-extraction-prompt').val(s.extraction.prompt);
    $('#ms-summary-words').val(s.summary.targetWords);
    $('#ms-summary-interval').val(summaryInterval);
    $('#ms-summary-interval-display').text(summaryIntervalLabel(summaryInterval));
    $('#ms-summary-window').val(s.summary.summaryWindowMessages ?? 50);
    $('#ms-summary-prompt').val(s.summary.prompt);
    $('#ms-world-tags-editor').val((s.worldTags || BUILTIN_WORLD_TAGS).join('\n'));
    const threshold = s.consolidation?.autoThreshold ?? 100;
    $('#ms-consolidation-threshold').val(threshold);
    $('#ms-consolidation-threshold-display').text(threshold === 0 ? 'never' : `${threshold} memories`);
    $('#ms-consolidation-prompt').val(s.consolidation?.prompt || DEFAULT_CONSOLIDATION_PROMPT);

    // General tab — budget slider + per-layer minimums
    const budget = s.contextBudgetTokens ?? 1200;
    $('#ms-budget-slider').val(budget);
    $('#ms-budget-slider-display').text(`${budget.toLocaleString()} tk`);
    const minS = s.inject.minSummary ?? 0;
    const minE = s.inject.minEvents  ?? 0;
    $('#ms-min-summary').val(minS);
    $('#ms-min-summary-display').text(`${minS} tk`);
    $('#ms-min-events').val(minE);
    $('#ms-min-events-display').text(`${minE} tk`);
    checkLayerMinWarning(budget, minS, minE);
}

// ---------------------------------------------------------------------------
// Identity editor helpers
// ---------------------------------------------------------------------------

/** Currently loaded identity object (kept in sync with form so Save always works). */
let _loadedIdentity = null;

/** Currently loaded character identity (kept in sync with char form so Save always works). */
let _loadedCharIdentity = null;

async function loadIdentityIntoEditor() {
    if (!currentWorldTag) {
        $('#ms-identity-editor').val('').attr('placeholder', 'No world tag active — identity is unavailable.');
        renderIdentityForm(emptyIdentity());
        return;
    }
    const avatarId = currentPersonaId || resolvePersonaId();
    const identity = await loadIdentity(avatarId, currentWorldTag, null);

    _loadedIdentity = identity;
    $('#ms-identity-editor').val(JSON.stringify(identity, null, 2));
    renderIdentityForm(identity);
}

/** Render the structured form from an identity object. */
function renderIdentityForm(identity) {
    const id = identity || emptyIdentity();
    const settings = getSettings();
    const customFieldKeys = settings.customIdentityFields || [];

    // — Titles (chips) —
    const $chips = $('#ms-identity-titles').empty();
    for (const title of (id.titles || [])) {
        $chips.append(makeChip(title));
    }

    // — Factions table —
    const $factions = $('#ms-identity-factions').empty();
    for (const f of (id.factions || [])) {
        $factions.append(makeTableRow([f.name || '', f.stance || ''], 'factions'));
    }

    // — Reputation table —
    const $rep = $('#ms-identity-reputation').empty();
    for (const [place, desc] of Object.entries(id.reputation || {})) {
        $rep.append(makeTableRow([place, desc], 'reputation'));
    }

    // — Relationships table —
    const $rel = $('#ms-identity-relationships').empty();
    for (const r of (id.relationships || [])) {
        $rel.append(makeTableRow([r.name || '', r.type || ''], 'relationships'));
    }

    // — Custom fields —
    const $custom = $('#ms-identity-custom').empty();
    // Merge: show all keys from settings + any in identity.custom not yet in settings
    const allCustomKeys = [...new Set([...customFieldKeys, ...Object.keys(id.custom || {})])];
    for (const key of allCustomKeys) {
        const val = (id.custom || {})[key] ?? '';
        $custom.append(`
            <div class="ms-custom-field-row" data-key="${escHtmlUtil(key)}">
                <span class="ms-custom-field-label">${escHtmlUtil(key)}</span>
                <input type="text" class="ms-custom-field-value" data-key="${escHtmlUtil(key)}" value="${escHtmlUtil(String(val))}" placeholder="value…">
                <button class="ms-row-delete ms-custom-field-delete" data-key="${escHtmlUtil(key)}" title="Remove field">✕</button>
            </div>`);
    }
}

// ---------------------------------------------------------------------------
// Character Knowledge form — routed to shared pool or persona silo based on persistentWorld
// ---------------------------------------------------------------------------

async function loadCharIdentityIntoForm() {
    if (!currentWorldTag || !currentCharacterName) {
        $('#ms-char-identity-char-label').text('Character Knowledge — (no character active)');
        renderCharIdentityForm(emptyIdentity());
        return;
    }
    $('#ms-char-identity-char-label').text(`Character Knowledge — ${currentCharacterName}`);
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    const avatarId = currentPersonaId || resolvePersonaId();
    const charIdentity = persistentWorld
        ? await loadSharedCharKnowledge(currentWorldTag, currentCharacterName).catch(() => null)
        : await loadIdentity(avatarId, currentWorldTag, currentCharacterName).catch(() => null);
    _loadedCharIdentity = charIdentity || emptyIdentity();
    renderCharIdentityForm(_loadedCharIdentity);
}

function renderCharIdentityForm(identity) {
    const id = identity || emptyIdentity();

    // Titles
    const $chips = $('#ms-char-identity-titles').empty();
    for (const title of (id.titles || [])) $chips.append(makeChip(title));

    // Factions
    const $factions = $('#ms-char-identity-factions').empty();
    for (const f of (id.factions || []))
        $factions.append(makeTableRow([f.name || '', f.stance || ''], 'char-factions'));

    // Reputation
    const $rep = $('#ms-char-identity-reputation').empty();
    for (const [place, desc] of Object.entries(id.reputation || {}))
        $rep.append(makeTableRow([place, desc], 'char-reputation'));

    // Relationships
    const $rel = $('#ms-char-identity-relationships').empty();
    for (const r of (id.relationships || []))
        $rel.append(makeTableRow([r.name || '', r.type || ''], 'char-relationships'));
}

function readCharIdentityFromForm() {
    const identity = emptyIdentity();

    $('#ms-char-identity-titles .ms-chip').each(function () {
        const t = $(this).find('.ms-chip-remove').data('title');
        if (t) identity.titles.push(t);
    });
    $('#ms-char-identity-factions tr').each(function () {
        const inputs = $(this).find('input');
        const name   = inputs.eq(0).val().trim();
        const stance = inputs.eq(1).val().trim();
        if (name) identity.factions.push({ name, stance });
    });
    $('#ms-char-identity-reputation tr').each(function () {
        const inputs = $(this).find('input');
        const place  = inputs.eq(0).val().trim();
        const desc   = inputs.eq(1).val().trim();
        if (place) identity.reputation[place] = desc;
    });
    $('#ms-char-identity-relationships tr').each(function () {
        const inputs = $(this).find('input');
        const name   = inputs.eq(0).val().trim();
        const type   = inputs.eq(1).val().trim();
        if (name) identity.relationships.push({ name, type });
    });
    return identity;
}

async function saveCharIdentityFromForm() {
    if (!currentWorldTag || !currentCharacterName) { toastr.warning('No world/character active.'); return; }
    try {
        const identity = readCharIdentityFromForm();
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        const avatarId = currentPersonaId || resolvePersonaId();
        if (persistentWorld) {
            await storeSharedCharKnowledge(currentWorldTag, currentCharacterName, identity);
        } else {
            await storeIdentity(avatarId, currentWorldTag, identity, currentCharacterName);
        }
        _loadedCharIdentity = identity;
        toastr.success('Character identity saved.');
    } catch (err) {
        toastr.error('Save failed: ' + err.message);
    }
}

async function resetCharIdentity() {
    if (!currentWorldTag || !currentCharacterName) { toastr.warning('No world/character active.'); return; }
    if (!confirm(`Reset character identity for "${currentCharacterName}"? This cannot be undone.`)) return;
    try {
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        const avatarId = currentPersonaId || resolvePersonaId();
        if (persistentWorld) {
            await storeSharedCharKnowledge(currentWorldTag, currentCharacterName, emptyIdentity());
        } else {
            await storeIdentity(avatarId, currentWorldTag, emptyIdentity(), currentCharacterName);
        }
        _loadedCharIdentity = emptyIdentity();
        renderCharIdentityForm(emptyIdentity());
        toastr.success('Character identity reset.');
    } catch (err) {
        toastr.error('Reset failed: ' + err.message);
    }
}

// ---------------------------------------------------------------------------
// World State display — shared pool (ON) or persona identity worldFacts (OFF)
// ---------------------------------------------------------------------------

async function loadWorldFactsDisplay() {
    if (!currentWorldTag) {
        $('#ms-worldfacts-world-label').text('World State — (no world active)');
        $('#ms-worldfacts-list').html('<p class="ms-hint" style="padding:4px 0;">No world tag active.</p>');
        $('#ms-worldfacts-count').text('');
        return;
    }
    $('#ms-worldfacts-world-label').text(`World State — ${currentWorldTag}`);
    try {
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        let worldFacts;
        if (persistentWorld) {
            const worldIdentity = await loadSharedWorldState(currentWorldTag);
            worldFacts = worldIdentity.worldFacts || [];
        } else {
            const avatarId = currentPersonaId || resolvePersonaId();
            const identity = await loadIdentity(avatarId, currentWorldTag, null);
            worldFacts = identity.worldFacts || [];
        }
        renderWorldFactsList(worldFacts);
    } catch (err) {
        $('#ms-worldfacts-list').html('<p class="ms-hint" style="padding:4px 0;">Failed to load world state.</p>');
    }
}

function renderWorldFactsList(facts) {
    const $list = $('#ms-worldfacts-list').empty();
    $('#ms-worldfacts-count').text(
        facts.length === 0
            ? 'No world state saved yet.'
            : `${facts.length} fact${facts.length !== 1 ? 's' : ''} saved`
    );
    if (!facts.length) {
        $list.append('<p class="ms-hint" style="padding:4px 0;">No world state saved yet.</p>');
        return;
    }
    facts.forEach((wf, i) => {
        const date = wf.ts ? new Date(wf.ts).toLocaleString() : '';
        $list.append(`
            <div class="ms-worldfact-row" data-index="${i}" data-fact="${escHtmlUtil(wf.fact || '')}">
                <span class="ms-worldfact-text">
                    ${date ? `<span class="ms-viewer-date">${escHtmlUtil(date)} — </span>` : ''}
                    ${escHtmlUtil(wf.fact || '')}
                </span>
                <button class="ms-worldfact-edit" data-index="${i}" title="Edit">✎</button>
                <button class="ms-row-delete ms-worldfact-world-delete" data-index="${i}" title="Delete">✕</button>
            </div>`);
    });
}

function addTitleFromInput() {
    const val = $('#ms-identity-title-input').val().trim();
    if (!val) return;
    // Avoid duplicates
    const existing = $('#ms-identity-titles .ms-chip-remove').map(function () { return $(this).data('title'); }).get();
    if (existing.includes(val)) { toastr.warning(`"${val}" is already listed.`); return; }
    $('#ms-identity-titles').append(makeChip(val));
    $('#ms-identity-title-input').val('');
}

function makeChip(text) {
    return $(`<span class="ms-chip">${escHtmlUtil(text)}<button class="ms-chip-remove" data-title="${escHtmlUtil(text)}" title="Remove">×</button></span>`);
}

function makeTableRow(values, section) {
    const cells = values.map(v => `<td><input type="text" value="${escHtmlUtil(v)}" placeholder="…"></td>`).join('');
    return $(`<tr data-section="${section}">${cells}<td><button class="ms-row-delete" title="Remove">✕</button></td></tr>`);
}

/** Read the current form state into an identity object. */
function readIdentityFromForm() {
    const identity = emptyIdentity();
    const settings = getSettings();

    // Titles from chips
    $('#ms-identity-titles .ms-chip').each(function () {
        const t = $(this).find('.ms-chip-remove').data('title');
        if (t) identity.titles.push(t);
    });

    // Factions
    $('#ms-identity-factions tr').each(function () {
        const inputs = $(this).find('input');
        const name   = inputs.eq(0).val().trim();
        const stance = inputs.eq(1).val().trim();
        if (name) identity.factions.push({ name, stance });
    });

    // Reputation
    $('#ms-identity-reputation tr').each(function () {
        const inputs = $(this).find('input');
        const place  = inputs.eq(0).val().trim();
        const desc   = inputs.eq(1).val().trim();
        if (place) identity.reputation[place] = desc;
    });

    // Relationships
    $('#ms-identity-relationships tr').each(function () {
        const inputs = $(this).find('input');
        const name   = inputs.eq(0).val().trim();
        const type   = inputs.eq(1).val().trim();
        if (name) identity.relationships.push({ name, type });
    });

    // World facts — no longer editable from this form (managed in the World State tab).
    // Preserve the loaded values unchanged so saving Your Profile doesn't wipe world facts.
    identity.worldFacts = _loadedIdentity?.worldFacts || [];

    // Custom fields
    $('#ms-identity-custom .ms-custom-field-value').each(function () {
        const key = $(this).data('key');
        const val = $(this).val();
        if (key) identity.custom[key] = val;
    });

    return identity;
}

async function saveIdentityFromEditor() {
    if (!currentWorldTag) { toastr.warning('No world tag active.'); return; }
    try {
        let identity;
        const isFormView = $('#ms-identity-form').is(':visible');
        if (isFormView) {
            identity = readIdentityFromForm();
        } else {
            identity = JSON.parse($('#ms-identity-editor').val());
        }
        const avatarId = currentPersonaId || resolvePersonaId();
        await storeIdentity(avatarId, currentWorldTag, identity, null);
        _loadedIdentity = identity;
        toastr.success('Identity saved.');
    } catch (e) {
        toastr.error('Save failed: ' + e.message);
    }
}

async function resetIdentity() {
    if (!currentWorldTag) { toastr.warning('No world tag active.'); return; }
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!confirm(`Reset Your Active Persona for world "${currentWorldTag}"? This cannot be undone.`)) return;

    try {
        await storeIdentity(avatarId, currentWorldTag, emptyIdentity(), null);
        invalidateIdentityCache(avatarId);
        _loadedIdentity = emptyIdentity();
        $('#ms-identity-editor').val(JSON.stringify(emptyIdentity(), null, 2));
        renderIdentityForm(emptyIdentity());
        toastr.success('Identity reset.');
    } catch (err) {
        console.error('[PAC] resetIdentity failed:', err);
        toastr.error('Failed to reset identity — check the console for details.');
    }
}

function refreshIdentityPanel() {
    if ($('.ms-tab-content[data-tab="identity"]').is(':visible'))   loadIdentityIntoEditor();
    if ($('.ms-tab-content[data-tab="character"]').is(':visible'))  loadCharIdentityIntoForm();
    if ($('.ms-tab-content[data-tab="worldstate"]').is(':visible')) loadWorldFactsDisplay();
}

// ---------------------------------------------------------------------------
// Persona tab helpers
// ---------------------------------------------------------------------------

async function loadPersonaList() {
    const avatarId = currentPersonaId || resolvePersonaId();
    updatePersonaIndicator();

    let personas = [];
    try { personas = await listPersonas(); } catch { personas = []; }

    const $list = $('#ms-persona-list').empty();
    if (!personas.length) {
        $list.append('<p class="ms-hint">No saved persona data found.</p>');
        return;
    }

    for (const id of personas) {
        const isCurrent = id === avatarId;
        $list.append(`
            <div class="ms-persona-row ${isCurrent ? 'ms-persona-active' : ''}">
                <span class="ms-persona-id">${escHtmlUtil(id)}</span>
                ${isCurrent ? '<span class="ms-badge ms-badge-green">active</span>' : ''}
            </div>
        `);
    }
}

async function deleteCurrentPersonaData() {
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!avatarId) { toastr.warning('No active persona.'); return; }
    if (!confirm(`Delete ALL PAC data for persona "${avatarId}"? This cannot be undone.`)) return;

    try {
        await deletePersonaData(avatarId);
        invalidateAllCaches(avatarId);
        toastr.success('Persona data deleted.');
        loadPersonaList();
    } catch (err) {
        toastr.error('Failed to delete persona data: ' + err.message);
    }
}

// ---------------------------------------------------------------------------
// World browser
// ---------------------------------------------------------------------------

/**
 * Shared handler for turning Persistent World ON or OFF.
 * Returns true if the change was saved, false if the user cancelled.
 */
async function confirmAndSetPersistentWorld(worldTag, turningOn, $checkboxToRevert) {
    if (turningOn) {
        const confirmed = confirm(
            `Turn ON Persistent World for "${worldTag}"?\n\n` +
            `From now on, Character Knowledge, World State, Memories, and Story So Far ` +
            `for this world will be stored in a shared pool accessible to all your personas.\n\n` +
            `Your existing per-persona memories will remain available to your current persona ` +
            `but won't update to the shared pool automatically.`
        );
        if (!confirmed) { if ($checkboxToRevert) $checkboxToRevert.prop('checked', false); return false; }
    } else {
        const confirmed = confirm(
            `Turn OFF Persistent World for "${worldTag}"?\n\n` +
            `Future memories will be stored privately under each persona. ` +
            `Existing shared world memories stay in the shared pool but won't be updated.`
        );
        if (!confirmed) { if ($checkboxToRevert) $checkboxToRevert.prop('checked', true); return false; }
    }
    setWorldSetting(worldTag, 'persistentWorld', turningOn);
    if (worldTag === currentWorldTag) {
        invalidateSharedCache(worldTag);
        updatePersistentWorldStatusToggle();
    }
    return true;
}

/** Sync the status-row Persistent World toggle with the current world's setting. */
function updatePersistentWorldStatusToggle() {
    if (!currentWorldTag) {
        $('#ms-pw-status-label').hide();
        return;
    }
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    $('#ms-pw-status-label').show();
    $('#ms-pw-status-toggle').prop('checked', !!persistentWorld);
}

async function loadWorldBrowser() {
    const avatarId = currentPersonaId || resolvePersonaId();
    const $container = $('#ms-world-browser').empty();
    $container.html('<p class="ms-hint" style="padding:6px 0;">Loading…</p>');

    try {
        const worlds = await getWorldList(avatarId);
        $container.empty();

        if (!worlds.length) {
            $container.html('<p class="ms-hint" style="padding:6px 0;">No world data saved yet.</p>');
            return;
        }

        for (const world of worlds) {
            const worldSettings   = getWorldSettings(world.tag);
            const persistentChecked = worldSettings.persistentWorld ? 'checked' : '';
            const totalEvents     = world.characters.reduce((s, c) => s + c.eventCount, 0);
            const totalSummaries  = world.characters.reduce((s, c) => s + c.summaryCount, 0);
            const isActive        = world.tag === currentWorldTag;

            const charRows = world.characters.map(c => `
                <div class="ms-world-char-row">
                    <span class="ms-world-char-name">${escHtmlUtil(c.name)}</span>
                    <span class="ms-hint ms-world-char-counts">
                        ${c.eventCount} memor${c.eventCount !== 1 ? 'ies' : 'y'} · ${c.summaryCount} summar${c.summaryCount !== 1 ? 'ies' : 'y'}
                    </span>
                    <div class="ms-world-char-actions">
                        <button class="ms-char-view-events menu_button"
                            data-world="${escHtmlUtil(world.tag)}"
                            data-char="${escHtmlUtil(c.name)}"
                            title="View memories for this character">Memories</button>
                        <button class="ms-char-delete menu_button danger"
                            data-world="${escHtmlUtil(world.tag)}"
                            data-char="${escHtmlUtil(c.name)}"
                            title="Delete all memory for this character">✕</button>
                    </div>
                </div>
            `).join('');

            $container.append(`
                <div class="ms-world-item" data-world="${escHtmlUtil(world.tag)}">
                    <div class="ms-world-header">
                        <span class="ms-world-toggle">▶</span>
                        <span class="ms-world-name">${escHtmlUtil(world.tag)}</span>
                        ${isActive ? '<span class="ms-badge ms-badge-green">active</span>' : ''}
                        <div class="ms-world-controls">
                            <label class="ms-persistent-world-label" title="Share memories, world state, and character knowledge across all personas">
                                <input type="checkbox" class="ms-persistent-world-toggle" data-world="${escHtmlUtil(world.tag)}" ${persistentChecked}>
                                <span>Persistent World</span>
                            </label>
                            <button class="ms-viewer-delete ms-world-delete" data-world="${escHtmlUtil(world.tag)}" title="Delete world data">✕</button>
                        </div>
                    </div>
                    <div class="ms-world-chars hidden">
                        <div class="ms-world-stats ms-hint">
                            ${worldSettings.persistentWorld ? 'Persistent World: ON' : 'Persistent World: OFF'} ·
                            ${totalEvents} total memor${totalEvents !== 1 ? 'ies' : 'y'} ·
                            ${totalSummaries} total summar${totalSummaries !== 1 ? 'ies' : 'y'}
                        </div>
                        ${charRows || '<div class="ms-hint ms-world-char-row">No character memory yet.</div>'}
                    </div>
                </div>
            `);
        }
    } catch (err) {
        $container.html('<p class="ms-hint" style="padding:6px 0;">Failed to load world data.</p>');
        console.error('[PAC] loadWorldBrowser error:', err);
    }
}

// ---------------------------------------------------------------------------
// Event log viewer
// ---------------------------------------------------------------------------

async function loadEventLog(overrideWorldTag, overrideCharName) {
    const context       = getContext();
    const worldTag      = overrideWorldTag  || currentWorldTag;
    const characterName = overrideCharName  || resolveCurrentCharName();
    const avatarId      = currentPersonaId  || resolvePersonaId();
    const isBrowsed     = !!(overrideWorldTag || overrideCharName);

    $('#ms-events-char-label').text(
        characterName
            ? `${worldTag ? `[${worldTag}] ` : ''}${characterName}${isBrowsed ? ' (browsed)' : ''}`
            : 'Character: —'
    );

    if (!characterName || !worldTag) {
        _loadedEvents = [];
        $('#ms-event-search').val('');
        $('#ms-events-list').html('<p class="ms-hint" style="padding:6px 8px;">No character/world active.</p>');
        $('#ms-events-count').text('');
        return;
    }

    $('#ms-events-count').text('Loading…');
    $('#ms-events-list').html('<p class="ms-hint" style="padding:6px 8px;">Loading…</p>');

    try {
        const { persistentWorld } = getWorldSettings(worldTag);
        const events = persistentWorld
            ? await getSharedEvents(worldTag, characterName, { limit: 1000 })
            : await getEvents(avatarId, worldTag, characterName, { limit: 1000 });
        _loadedEvents = events;
        $('#ms-event-search').val('');
        renderEventList(events);
    } catch (err) {
        _loadedEvents = [];
        $('#ms-events-list').html('<p class="ms-hint" style="padding:6px 8px;">Failed to load memories.</p>');
        console.error('[PAC] loadEventLog error:', err);
    }
}

/**
 * Build the HTML for a single event row.
 * @param {{event:string,ts:number,tags:string[]}} ev
 * @param {number} fileIndex  Index in the full _loadedEvents array (used for delete)
 */
function buildEventRowHtml(ev, fileIndex) {
    const date = ev.ts ? new Date(ev.ts).toLocaleString() : '';
    const tags = ev.tags?.length ? ev.tags.join(', ') : '';
    return `<div class="ms-viewer-item">
                <div class="ms-viewer-item-body">
                    ${date ? `<span class="ms-viewer-date">${escHtmlUtil(date)} — </span>` : ''}
                    <span class="ms-viewer-text">${escHtmlUtil(ev.event || '(empty)')}</span>
                    ${tags ? `<div class="ms-viewer-tags">${escHtmlUtil(tags)}</div>` : ''}
                </div>
                <button class="ms-viewer-edit" data-index="${fileIndex}" title="Edit this memory">✎</button>
                <button class="ms-viewer-delete" data-index="${fileIndex}" title="Delete this event">✕</button>
            </div>`;
}

/** Render a filtered subset of events into the event list DOM. */
function renderEventList(events) {
    const displayed = events.slice(-50);

    $('#ms-events-count').text(
        events.length === 0
            ? 'No events logged yet.'
            : `Showing ${displayed.length} most recent of ${events.length} total`
    );

    const $list = $('#ms-events-list').empty();
    if (!displayed.length) {
        $list.html('<p class="ms-hint" style="padding:6px 8px;">No events logged yet.</p>');
        return;
    }

    // Build a single HTML string for all rows — avoids per-item reflows on large logs
    const rows = [...displayed].reverse().map((ev, i) => {
        const fileIndex = events.length - 1 - i;
        return buildEventRowHtml(ev, fileIndex);
    });
    $list.html(rows.join(''));
}

/** Filter the cached event list by a search query (case-insensitive substring). */
function filterEventLog(query) {
    if (!query.trim()) {
        renderEventList(_loadedEvents);
        return;
    }
    const q       = query.toLowerCase();
    const matched = _loadedEvents.filter(e => (e.event || '').toLowerCase().includes(q));
    const $list   = $('#ms-events-list').empty();

    if (!matched.length) {
        $list.html('<p class="ms-hint" style="padding:6px 8px;">No events match your search.</p>');
        $('#ms-events-count').text(`0 of ${_loadedEvents.length} total match "${escHtmlUtil(query)}"`);
        return;
    }

    $('#ms-events-count').text(`${matched.length} of ${_loadedEvents.length} total match "${escHtmlUtil(query)}"`);
    // Show all matching events (not capped to 50) when searching
    // Build a single HTML string for all rows — avoids per-item reflows on large logs
    const rows = [...matched].reverse().map(ev => {
        const fileIndex = _loadedEvents.indexOf(ev);
        return buildEventRowHtml(ev, fileIndex);
    });
    $list.html(rows.join(''));
}

async function addManualEvent() {
    const text = $('#ms-manual-event-input').val().trim();
    if (!text) { toastr.warning('Enter an event description first.'); return; }
    if (!currentWorldTag) { toastr.warning('No world tag active.'); return; }

    const context = getContext();
    const characterName = resolveCurrentCharName();
    if (!characterName) { toastr.warning('No character selected.'); return; }

    const avatarId = currentPersonaId || resolvePersonaId();
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    try {
        if (persistentWorld) {
            await logSharedEvent(currentWorldTag, characterName, text, ['manual'], context.chatId);
        } else {
            await logEvent(avatarId, currentWorldTag, characterName, text, ['manual'], context.chatId);
        }
        $('#ms-manual-event-input').val('');
        toastr.success('Event added.');
        await loadEventLog();
    } catch {
        toastr.error('Failed to add event.');
    }
}

async function deleteEventEntry(index) {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!characterName || !currentWorldTag) return;
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    try {
        if (persistentWorld) {
            await deleteSharedEvent(currentWorldTag, characterName, index);
        } else {
            await deleteEvent(avatarId, currentWorldTag, characterName, index);
        }
        await loadEventLog();
    } catch {
        toastr.error('Failed to delete event.');
    }
}

async function clearAllEvents() {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!characterName || !currentWorldTag) { toastr.warning('No character/world active.'); return; }
    if (!confirm(`Clear ALL events for "${characterName}" in world "${currentWorldTag}"? This cannot be undone.`)) return;
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    try {
        if (persistentWorld) {
            await clearSharedEvents(currentWorldTag, characterName);
        } else {
            await clearEvents(avatarId, currentWorldTag, characterName);
            purgeEventVectors(avatarId, currentWorldTag, characterName).catch(() => {});
        }
        toastr.success('All events cleared.');
        await loadEventLog();
    } catch {
        toastr.error('Failed to clear events.');
    }
}

async function rebuildVectorIndex() {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();

    if (!characterName || !currentWorldTag) {
        toastr.warning('No active character/world.');
        return;
    }

    const $btn = $('#ms-btn-rebuild-vectors');
    $btn.prop('disabled', true).text('Rebuilding…');
    $('#ms-rebuild-status').text('Loading events…');
    try {
        const events = await getEvents(avatarId, currentWorldTag, characterName, { limit: 2000 });
        if (!events.length) {
            $('#ms-rebuild-status').text('No events to index.');
            return;
        }
        $('#ms-rebuild-status').text(`Indexing ${events.length} event${events.length !== 1 ? 's' : ''}…`);
        await rebuildEventIndex(avatarId, currentWorldTag, characterName, events);
        $('#ms-rebuild-status').text(`✓ Indexed ${events.length} event${events.length !== 1 ? 's' : ''}`);
        toastr.success(`Vector index rebuilt: ${events.length} events indexed.`);
    } catch (err) {
        console.error('[PAC] Vector index rebuild failed:', err);
        $('#ms-rebuild-status').text('Failed — see console.');
        toastr.error(
            'Vector index rebuild failed. Check the browser console. ' +
            'ST\'s Vectors extension may still be downloading the model (~420 MB on first run).',
        );
    } finally {
        $btn.prop('disabled', false).text('Rebuild Vector Index');
    }
}

// ---------------------------------------------------------------------------
// Summary viewer
// ---------------------------------------------------------------------------

async function loadSummaryList() {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();

    if (!characterName || !currentWorldTag) {
        $('#ms-summaries-list').html('<p class="ms-hint" style="padding:6px 8px;">No character/world active.</p>');
        $('#ms-summaries-count').text('');
        return;
    }

    $('#ms-summaries-count').text('Loading…');
    $('#ms-summaries-list').html('<p class="ms-hint" style="padding:6px 8px;">Loading…</p>');

    try {
        const { persistentWorld } = getWorldSettings(currentWorldTag);
        const summaries = persistentWorld
            ? await getSharedSummaries(currentWorldTag, characterName, { limit: 1000 })
            : await getSummaries(avatarId, currentWorldTag, characterName, { limit: 1000 });

        $('#ms-summaries-count').text(
            summaries.length === 0
                ? 'No summaries saved yet.'
                : `${summaries.length} session summar${summaries.length === 1 ? 'y' : 'ies'} stored`
        );

        const $list = $('#ms-summaries-list').empty();
        if (!summaries.length) {
            $list.append('<p class="ms-hint" style="padding:6px 8px;">No summaries saved yet.</p>');
            return;
        }

        [...summaries].reverse().forEach((s, i) => {
            const fileIndex  = summaries.length - 1 - i;
            const date       = s.ts ? new Date(s.ts).toLocaleDateString() : '';
            const wordCount  = s.summary ? s.summary.split(/\s+/).filter(Boolean).length : 0;
            const label      = `${date ? date + ' — ' : ''}${wordCount} words`;
            $list.append(`
                <div class="ms-summary-item">
                    <div class="ms-summary-header">
                        <span class="ms-summary-toggle">▶</span>
                        <span class="ms-summary-title">${escHtmlUtil(label)}</span>
                        <button class="ms-summary-edit" data-index="${fileIndex}" title="Edit this summary">✎</button>
                        <button class="ms-viewer-delete ms-summary-delete" data-index="${fileIndex}" title="Delete this summary">✕</button>
                    </div>
                    <div class="ms-summary-body">${escHtmlUtil(s.summary || '')}</div>
                </div>
            `);
        });
    } catch (err) {
        $('#ms-summaries-list').html('<p class="ms-hint" style="padding:6px 8px;">Failed to load summaries.</p>');
        console.error('[PAC] loadSummaryList error:', err);
    }
}

async function deleteSummaryEntry(index) {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!characterName || !currentWorldTag) return;
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    try {
        if (persistentWorld) {
            await deleteSharedSummary(currentWorldTag, characterName, index);
        } else {
            await deleteSummary(avatarId, currentWorldTag, characterName, index);
        }
        await loadSummaryList();
    } catch {
        toastr.error('Failed to delete summary.');
    }
}

async function clearAllSummaries() {
    const context = getContext();
    const characterName = resolveCurrentCharName();
    const avatarId = currentPersonaId || resolvePersonaId();
    if (!characterName || !currentWorldTag) { toastr.warning('No character/world active.'); return; }
    if (!confirm(`Clear ALL summaries for "${characterName}" in world "${currentWorldTag}"? This cannot be undone.`)) return;
    const { persistentWorld } = getWorldSettings(currentWorldTag);
    try {
        if (persistentWorld) {
            await clearSharedSummaries(currentWorldTag, characterName);
        } else {
            await clearSummaries(avatarId, currentWorldTag, characterName);
        }
        toastr.success('All summaries cleared.');
        await loadSummaryList();
    } catch {
        toastr.error('Failed to clear summaries.');
    }
}

function escHtmlUtil(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, onSettingsLoaded);
    eventSource.on(event_types.CHAT_LOADED,  onChatLoaded);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforeGenerate);
    eventSource.on(event_types.SETTINGS_UPDATED, onSettingsUpdated);

    await initSettingsPanel();

    // Plugin health check — show persistent banner + first-time setup modal
    try {
        await healthCheck();
        pluginOnline = true;
        $('#ms-plugin-banner').addClass('hidden');
    } catch {
        pluginOnline = false;
        $('#ms-plugin-banner').removeClass('hidden');
        console.warn('[PAC] Server plugin not responding — memory features disabled.');

        // Show onboarding modal so first-time users know exactly what to do
        const $modal = $('#pac-setup-modal');
        $modal.removeClass('hidden');
        $('#pac-setup-copy').on('click', function () {
            navigator.clipboard.writeText('enableServerPlugins: true').then(() => {
                $(this).text('Copied!');
                setTimeout(() => $(this).text('Copy'), 1800);
            }).catch(() => {
                $(this).text('Copy failed');
            });
        });
        $('#pac-setup-dismiss').on('click', () => $modal.addClass('hidden'));
        // Clicking the backdrop also dismisses
        $modal.on('click', function (e) {
            if (e.target === this) $modal.addClass('hidden');
        });
    }

    updateHealthChecks();
    console.log('[PAC] Extension loaded.');
}

init().catch(err => console.error('[PAC] Init failed:', err));

export { MODULE_NAME };
