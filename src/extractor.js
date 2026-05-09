/**
 * AI fact extractor — sends recent chat to the LLM and parses structured facts.
 *
 * Four-way classification:
 *   personaFacts   — permanent truths about WHO the user PERSONA IS (titles, faction standings, reputation)
 *   characterFacts — permanent truths about WHO the AI CHARACTER IS (their titles, reputation, relationships)
 *   worldFacts     — permanent truths about the WORLD (settled history from this playthrough)
 *   events         — episodic, happened-once moments for the RAG event log
 *
 * Shows an approval dialog before writing anything to storage.
 */

import { generateRaw } from '../../../../../script.js';

export const DEFAULT_EXTRACTION_PROMPT =
    'You extract memory facts from roleplay transcripts and return them as JSON.\n' +
    'Think in ONE sentence only, then immediately output the JSON. ' +
    'Do NOT reason at length. Do NOT write anything outside the JSON object.\n\n' +
    'Four buckets:\n' +
    '• personaFacts   — permanent truths about WHO THE USER PERSONA IS: titles, faction standings, reputation, NPC relationships, custom fields\n' +
    '• characterFacts — permanent truths about WHO THE AI CHARACTER IS: their titles, affiliations, reputation, relationships\n' +
    '• worldFacts     — world-altering permanent changes now settled as history\n' +
    '• events         — episodic moments, encounters, actions (searchable memory log)\n\n' +
    'Return ONLY this JSON (omit empty arrays/objects, return {} if nothing extractable):\n' +
    '{\n' +
    '  "personaFacts": {\n' +
    '    "titles": [{"action":"add|remove","title":"title name"}],\n' +
    '    "factions": [{"name":"faction name","stance":"allied|hostile|neutral|..."}],\n' +
    '    "reputation": {"location or group": "descriptor"},\n' +
    '    "relationships": [{"name":"NPC name","type":"relationship type"}],\n' +
    '    "custom": {"key": "value"}\n' +
    '  },\n' +
    '  "characterFacts": {\n' +
    '    "titles": [{"action":"add|remove","title":"title name"}],\n' +
    '    "factions": [{"name":"faction name","stance":"allied|hostile|neutral|..."}],\n' +
    '    "reputation": {"location or group": "descriptor"},\n' +
    '    "relationships": [{"name":"NPC name","type":"relationship type"}]\n' +
    '  },\n' +
    '  "worldFacts": ["One sentence permanent world change"],\n' +
    '  "events": ["Short episodic event description"]\n' +
    '}\n' +
    'After your one-sentence reasoning, output the JSON object immediately. No markdown fences.';

/**
 * Run AI extraction on a slice of chat messages.
 * @param {Array}   messages          Recent chat messages {name, mes, is_user}
 * @param {string}  systemPrompt      Extraction prompt (configurable)
 * @param {string[]} customFieldNames User-defined custom identity field names to append
 * @returns {Promise<object|null>} Parsed extraction result or null
 */
export async function runExtraction(messages, systemPrompt = DEFAULT_EXTRACTION_PROMPT, customFieldNames = [], attribution = {}) {
    if (!messages?.length) return null;

    // Append custom field guidance dynamically so it stays current without editing the saved prompt
    let effectivePrompt = systemPrompt;
    if (customFieldNames.length) {
        const fieldList = customFieldNames.map(k => `- ${k}`).join('\n');
        effectivePrompt += `\n\nCUSTOM FIELDS TO TRACK (under personaFacts.custom — plain text values):\n${fieldList}`;
    }

    // Ground the LLM on which transcript speaker is the AI character vs the user persona.
    // Without this, the LLM must guess from context — unreliable when persona names look like character names.
    if (attribution.characterName || attribution.personaName) {
        const lines = ['\n\nSCENE ATTRIBUTION — use these to classify correctly:'];
        if (attribution.characterName) {
            lines.push(`• "${attribution.characterName}" is the AI CHARACTER → their facts go under characterFacts`);
        }
        if (attribution.personaName) {
            lines.push(`• "${attribution.personaName}" is the USER PERSONA → their facts go under personaFacts`);
        }
        effectivePrompt += lines.join('\n');
    }

    const transcript = messages
        .filter(m => m.mes?.trim())
        .map(m => `${m.name}: ${m.mes.trim()}`)
        .join('\n');

    if (!transcript) return null;

    try {
        const raw = await generateRaw({
            prompt: transcript,
            systemPrompt: effectivePrompt,
            responseLength: 10000,  // generous ceiling for thinking models — CoT can run 3-5k tokens before JSON output
        });

        if (!raw) return null;
        return parseExtractionJson(raw);
    } catch (err) {
        console.error('[PAC] Extraction failed:', err);
        return null;
    }
}

/**
 * Parse the LLM's JSON response, stripping markdown fences if present.
 * @param {string} raw
 * @returns {object|null}
 */
function parseExtractionJson(raw) {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
        const obj = JSON.parse(text);
        return typeof obj === 'object' ? obj : null;
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { }
        }
        console.warn('[PAC] Could not parse extraction JSON:', raw.slice(0, 200));
        return null;
    }
}

/**
 * Check if an extraction result has any actionable content.
 * @param {object} extraction
 * @returns {boolean}
 */
export function hasContent(extraction) {
    if (!extraction) return false;
    const pf = extraction.personaFacts || {};
    const hasPersonaFacts = (
        (pf.titles?.length > 0) ||
        (pf.factions?.length > 0) ||
        (pf.relationships?.length > 0) ||
        (pf.reputation && Object.keys(pf.reputation).length > 0) ||
        (pf.custom && Object.keys(pf.custom).length > 0)
    );
    const cf = extraction.characterFacts || {};
    const hasCharFacts = (
        (cf.titles?.length > 0) ||
        (cf.factions?.length > 0) ||
        (cf.relationships?.length > 0) ||
        (cf.reputation && Object.keys(cf.reputation).length > 0)
    );
    return hasPersonaFacts ||
        hasCharFacts ||
        (extraction.worldFacts?.length > 0) ||
        (extraction.events?.length > 0);
}

/**
 * Show the approval dialog for an extraction result.
 *
 * Returns { personaFacts, worldFacts, events } with only approved entries,
 * or null if the user dismissed the dialog.
 *
 * @param {object} extraction
 * @param {string} characterName  Bot character name (for dialog title)
 * @returns {Promise<{personaFacts: object, characterFacts: object, worldFacts: string[], events: string[]}|null>}
 */
export async function showApprovalDialog(extraction, characterName) {
    return new Promise((resolve) => {
        const sections = [];
        const pf = extraction.personaFacts || {};
        const cf = extraction.characterFacts || {};

        // --- Persona Facts ---
        const pfRows = [];

        if (pf.titles?.length) {
            pf.titles.forEach((t, i) => {
                pfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="pf-titles" data-index="${i}">
                    <span class="ms-badge ms-badge-${t.action === 'add' ? 'green' : 'red'}">${t.action}</span>
                    title: ${escHtml(t.title)}
                </label>`);
            });
        }

        if (pf.factions?.length) {
            pf.factions.forEach((f, i) => {
                pfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="pf-factions" data-index="${i}">
                    <span class="ms-badge ms-badge-blue">faction</span>
                    ${escHtml(f.name)}: ${escHtml(f.stance || 'neutral')}
                </label>`);
            });
        }

        if (pf.reputation && Object.keys(pf.reputation).length) {
            Object.entries(pf.reputation).forEach(([place, desc]) => {
                pfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="pf-reputation" data-key="${escHtml(place)}">
                    <span class="ms-badge ms-badge-blue">rep</span>
                    ${escHtml(desc)} in ${escHtml(place)}
                </label>`);
            });
        }

        if (pf.relationships?.length) {
            pf.relationships.forEach((r, i) => {
                pfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="pf-relationships" data-index="${i}">
                    <span class="ms-badge ms-badge-blue">relation</span>
                    ${escHtml(r.name)}: ${escHtml(r.type || '')}
                </label>`);
            });
        }

        if (pf.custom && Object.keys(pf.custom).length) {
            Object.entries(pf.custom).forEach(([k, v]) => {
                pfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="pf-custom" data-key="${escHtml(k)}">
                    <strong>${escHtml(k)}:</strong> ${escHtml(String(v))}
                </label>`);
            });
        }

        if (pfRows.length) {
            sections.push(`<div class="ms-section"><h4>Your Active Persona</h4>${pfRows.join('')}</div>`);
        }

        // --- Character Facts ---
        const cfRows = [];

        if (cf.titles?.length) {
            cf.titles.forEach((t, i) => {
                cfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="cf-titles" data-index="${i}">
                    <span class="ms-badge ms-badge-${t.action === 'add' ? 'green' : 'red'}">${t.action}</span>
                    title: ${escHtml(t.title)}
                </label>`);
            });
        }

        if (cf.factions?.length) {
            cf.factions.forEach((f, i) => {
                cfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="cf-factions" data-index="${i}">
                    <span class="ms-badge ms-badge-purple">faction</span>
                    ${escHtml(f.name)}: ${escHtml(f.stance || 'neutral')}
                </label>`);
            });
        }

        if (cf.reputation && Object.keys(cf.reputation).length) {
            Object.entries(cf.reputation).forEach(([place, desc]) => {
                cfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="cf-reputation" data-key="${escHtml(place)}">
                    <span class="ms-badge ms-badge-purple">rep</span>
                    ${escHtml(desc)} in ${escHtml(place)}
                </label>`);
            });
        }

        if (cf.relationships?.length) {
            cf.relationships.forEach((r, i) => {
                cfRows.push(`<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="cf-relationships" data-index="${i}">
                    <span class="ms-badge ms-badge-purple">relation</span>
                    ${escHtml(r.name)}: ${escHtml(r.type || '')}
                </label>`);
            });
        }

        if (cfRows.length) {
            sections.push(`<div class="ms-section"><h4>Character Knowledge — ${escHtml(characterName)}</h4>${cfRows.join('')}</div>`);
        }

        // --- World Facts ---
        if (extraction.worldFacts?.length) {
            const rows = extraction.worldFacts.map((f, i) =>
                `<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="worldFacts" data-index="${i}">
                    <span class="ms-badge ms-badge-orange">world</span>
                    ${escHtml(f)}
                </label>`
            ).join('');
            sections.push(`<div class="ms-section"><h4>World State</h4>${rows}</div>`);
        }

        // --- Events ---
        if (extraction.events?.length) {
            const rows = extraction.events.map((e, i) =>
                `<label class="ms-approval-item">
                    <input type="checkbox" checked data-section="events" data-index="${i}">
                    ${escHtml(e)}
                </label>`
            ).join('');
            sections.push(`<div class="ms-section"><h4>Memories</h4>${rows}</div>`);
        }

        if (!sections.length) {
            resolve(null);
            return;
        }

        const dialogHtml = `
            <div class="ms-dialog-header">
                <h3>Memory Extraction — ${escHtml(characterName)}</h3>
                <p class="ms-dialog-subtitle">Review and approve what gets saved to memory.</p>
            </div>
            <div class="ms-dialog-body">${sections.join('')}</div>
        `;

        const dialog = $('<div class="ms-approval-dialog">').html(dialogHtml);

        // Guard against double-resolve: jQuery UI fires the 'close' event
        // synchronously when dialog('close') is called, which would resolve(null)
        // before resolve(result) runs — silently discarding the approval.
        let settled = false;

        dialog.dialog({
            title: 'PAC — Review Memory Extraction',
            width: 520,
            maxHeight: 620,
            modal: true,
            buttons: {
                'Save Approved': function () {
                    const result = buildApprovedResult($(this), extraction);
                    settled = true;
                    $(this).dialog('close');
                    resolve(result);
                },
                'Skip': function () {
                    settled = true;
                    $(this).dialog('close');
                    resolve(null);
                },
            },
            close: function () {
                // Only resolve if the user dismissed via the × button (not via a button above)
                if (!settled) resolve(null);
            },
        });
    });
}

/**
 * Build the approved result from dialog checkbox state.
 * @returns {{ personaFacts: object, characterFacts: object, worldFacts: string[], events: string[] }}
 */
function buildApprovedResult(dialogEl, extraction) {
    const personaFacts = {};
    const characterFacts = {};
    const worldFacts = [];
    const events = [];
    const pf = extraction.personaFacts || {};
    const cf = extraction.characterFacts || {};

    dialogEl.find('input[type=checkbox]:checked').each(function () {
        const section = $(this).data('section');
        const index = $(this).data('index');
        const key = $(this).data('key');

        switch (section) {
            // --- Persona Facts ---
            case 'pf-titles':
                personaFacts.titles = personaFacts.titles || [];
                personaFacts.titles.push(pf.titles[index]);
                break;
            case 'pf-factions':
                personaFacts.factions = personaFacts.factions || [];
                personaFacts.factions.push(pf.factions[index]);
                break;
            case 'pf-reputation':
                personaFacts.reputation = personaFacts.reputation || {};
                personaFacts.reputation[key] = pf.reputation[key];
                break;
            case 'pf-relationships':
                personaFacts.relationships = personaFacts.relationships || [];
                personaFacts.relationships.push(pf.relationships[index]);
                break;
            case 'pf-custom':
                personaFacts.custom = personaFacts.custom || {};
                personaFacts.custom[key] = pf.custom[key];
                break;
            // --- Character Facts ---
            case 'cf-titles':
                characterFacts.titles = characterFacts.titles || [];
                characterFacts.titles.push(cf.titles[index]);
                break;
            case 'cf-factions':
                characterFacts.factions = characterFacts.factions || [];
                characterFacts.factions.push(cf.factions[index]);
                break;
            case 'cf-reputation':
                characterFacts.reputation = characterFacts.reputation || {};
                characterFacts.reputation[key] = cf.reputation[key];
                break;
            case 'cf-relationships':
                characterFacts.relationships = characterFacts.relationships || [];
                characterFacts.relationships.push(cf.relationships[index]);
                break;
            // --- World / Events ---
            case 'worldFacts':
                worldFacts.push(extraction.worldFacts[index]);
                break;
            case 'events':
                events.push(extraction.events[index]);
                break;
        }
    });

    return { personaFacts, characterFacts, worldFacts, events };
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
