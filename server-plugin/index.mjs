import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// BM25 — self-contained keyword ranking (no external dependencies)
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

const STOPWORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'by','from','is','was','are','were','be','been','being','have','has',
    'had','do','does','did','will','would','could','should','may','might',
    'shall','can','not','no','nor','so','yet','both','either','neither',
    'than','then','that','this','these','those','i','you','he','she','it',
    'we','they','me','him','her','us','them','my','your','his','its','our',
    'their','what','which','who','whom','when','where','why','how',
]);

/**
 * Tokenize a string into lowercase terms, removing stopwords.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^[-']+|[-']+$/g, ''))
        .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * BM25 ranking over an array of event objects.
 * @param {Array}  events   Array of { event, ts, ... }
 * @param {string} query    User query text
 * @param {number} topK     Number of results to return
 * @returns {Array} Sorted results: [{ event, ts, index, score }, ...]
 */
function bm25Search(events, query, topK = 5) {
    if (!events.length || !query) return [];

    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];

    // Tokenize all documents
    const docs = events.map(e => tokenize(e.event || ''));
    const N = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.length, 0) / N;

    // Build IDF — count documents containing each query term
    const df = new Map();
    for (const term of queryTerms) {
        if (df.has(term)) continue;
        let count = 0;
        for (const doc of docs) {
            if (doc.includes(term)) count++;
        }
        df.set(term, count);
    }

    // Score each document
    const scores = docs.map((doc, i) => {
        const dl = doc.length;
        let score = 0;

        for (const term of queryTerms) {
            const tf = doc.filter(t => t === term).length;
            if (tf === 0) continue;
            const idf = Math.log((N - df.get(term) + 0.5) / (df.get(term) + 0.5) + 1);
            score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));
        }

        return { index: i, score };
    });

    return scores
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(r => ({
            event: events[r.index].event,
            ts:    events[r.index].ts,
            index: r.index,
            score: r.score,
        }));
}

export const info = {
    id: 'pac',
    name: 'Persistent Adventure Chronicle',
    description: 'Persistent memory for SillyTavern character cards — profiles, world state, memories, and story summaries.',
};

function msRoot(req) {
    return path.join(req.user.directories.extensions, 'pac');
}

function personaRoot(req, avatarId) {
    return path.join(msRoot(req), 'personas', sanitizeName(avatarId));
}

function worldRoot(req, avatarId, worldTag) {
    return path.join(personaRoot(req, avatarId), 'worlds', sanitizeName(worldTag));
}

function worldCharRoot(req, avatarId, worldTag, charName) {
    return path.join(worldRoot(req, avatarId, worldTag), 'characters', sanitizeName(charName));
}

function sharedWorldRoot(req, worldTag) {
    return path.join(msRoot(req), 'worlds', sanitizeName(worldTag));
}

function sharedCharRoot(req, worldTag, charName) {
    return path.join(sharedWorldRoot(req, worldTag), 'characters', sanitizeName(charName));
}

/**
 * Sanitize a name for use as a filesystem path component.
 * Strips path separators and null bytes; collapses whitespace to underscores.
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
    const result = String(name)
        .replace(/[\x00/\\:*?"<>|]/g, '')
        .replace(/\s+/g, '_')
        .trim();
    if (result === '..' || result === '.') return '';
    return result;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, defaultValue = {}) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return defaultValue;
    }
}

function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJsonl(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map(l => JSON.parse(l));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[PAC] Failed to read ${path.basename(filePath)}:`, err.message);
        }
        return [];
    }
}

function appendJsonl(filePath, record) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function writeJsonl(filePath, records) {
    ensureDir(path.dirname(filePath));
    const content = records.map(r => JSON.stringify(r)).join('\n');
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content ? content + '\n' : '', 'utf8');
    fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Plugin init
// ---------------------------------------------------------------------------

export async function init(router) {
    router.use((req, res, next) => {
        if (!req.user?.directories?.extensions) return res.status(401).json({ error: 'Unauthorized' });
        next();
    });

    // -----------------------------------------------------------------------
    // Health check — lightweight ping to confirm the plugin is alive
    // -----------------------------------------------------------------------

    router.get('/health', (_req, res) => res.json({ ok: true }));

    // -----------------------------------------------------------------------
    // Personas — list, meta, delete
    // -----------------------------------------------------------------------

    router.get('/personas', (req, res) => {
        const dir = path.join(msRoot(req), 'personas');
        try {
            ensureDir(dir);
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            res.json(entries.filter(e => e.isDirectory()).map(e => e.name));
        } catch {
            res.json([]);
        }
    });

    router.get('/personas/:avatarId/meta', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });
        res.json(readJson(path.join(personaRoot(req, avatarId), 'meta.json'), {}));
    });

    router.post('/personas/:avatarId/meta', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });
        const file = path.join(personaRoot(req, avatarId), 'meta.json');
        const data = { ...readJson(file, {}), ...req.body, avatarId, updatedAt: new Date().toISOString() };
        writeJson(file, data);
        res.json(data);
    });

    router.delete('/personas/:avatarId', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });
        const dir = path.join(msRoot(req), 'personas', avatarId);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[PAC] Deleted persona: ${avatarId}`);
            res.json({ deleted: avatarId });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // -----------------------------------------------------------------------
    // World browser — list all worlds with character stats
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/worlds', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });

        const worldsDir = path.join(personaRoot(req, avatarId), 'worlds');
        if (!fs.existsSync(worldsDir)) return res.json([]);

        try {
            const worlds = [];
            const worldDirs = fs.readdirSync(worldsDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);

            for (const worldTag of worldDirs) {
                const wRoot = path.join(worldsDir, worldTag);
                const hasWorldIdentity = fs.existsSync(path.join(wRoot, 'identity.json'));
                const characters = [];

                const charsDir = path.join(wRoot, 'characters');
                if (fs.existsSync(charsDir)) {
                    const charDirs = fs.readdirSync(charsDir, { withFileTypes: true })
                        .filter(e => e.isDirectory())
                        .map(e => e.name);

                    for (const charName of charDirs) {
                        const cRoot = path.join(charsDir, charName);
                        const eventCount  = readJsonl(path.join(cRoot, 'events.jsonl')).length;
                        const summaryCount = readJsonl(path.join(cRoot, 'summaries.jsonl')).length;
                        const hasCharIdentity = fs.existsSync(path.join(cRoot, 'identity.json'));
                        characters.push({ name: charName, eventCount, summaryCount, hasCharIdentity });
                    }
                }

                worlds.push({ tag: worldTag, hasWorldIdentity, characters });
            }

            res.json(worlds);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // -----------------------------------------------------------------------
    // World-level identity (crossCharacter = ON)
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/worlds/:worldTag/identity', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        if (!avatarId || !worldTag) return res.status(400).json({ error: 'Invalid params' });
        res.json(readJson(path.join(worldRoot(req, avatarId, worldTag), 'identity.json'), {}));
    });

    router.post('/personas/:avatarId/worlds/:worldTag/identity', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        if (!avatarId || !worldTag) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(worldRoot(req, avatarId, worldTag), 'identity.json');
        const data = { ...req.body, lastUpdated: new Date().toISOString() };
        writeJson(file, data);
        res.json(data);
    });

    // -----------------------------------------------------------------------
    // Character-level identity (crossCharacter = OFF)
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/worlds/:worldTag/characters/:name/identity', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        res.json(readJson(path.join(worldCharRoot(req, avatarId, worldTag, name), 'identity.json'), {}));
    });

    router.post('/personas/:avatarId/worlds/:worldTag/characters/:name/identity', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(worldCharRoot(req, avatarId, worldTag, name), 'identity.json');
        const data = { ...req.body, lastUpdated: new Date().toISOString() };
        writeJson(file, data);
        res.json(data);
    });

    // -----------------------------------------------------------------------
    // Character events (world-scoped)
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/worlds/:worldTag/characters/:name/events', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl');
        const all  = readJsonl(file);
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit  = Math.min(1000, parseInt(req.query.limit, 10) || 200);
        res.json(all.slice(offset, offset + limit));
    });

    router.post('/personas/:avatarId/worlds/:worldTag/characters/:name/events', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl');
        // Deduplicate: skip if the exact event text already exists in the last 200 entries
        if (req.body.event) {
            const existing = readJsonl(file);
            const recentTexts = new Set(existing.slice(-200).map(e => e.event));
            if (recentTexts.has(req.body.event)) {
                return res.json({ duplicate: true, skipped: true });
            }
        }
        const record = { ts: new Date().toISOString(), ...req.body };
        appendJsonl(file, record);
        res.json(record);
    });

    router.delete('/personas/:avatarId/worlds/:worldTag/characters/:name/events', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        writeJsonl(path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl'), []);
        console.log(`[PAC] Cleared events: ${avatarId}/${worldTag}/${name}`);
        res.json({ cleared: true });
    });

    router.delete('/personas/:avatarId/worlds/:worldTag/characters/:name/events/:index', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!avatarId || !worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        const file    = path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records.splice(index, 1);
        writeJsonl(file, records);
        res.json({ deleted: index, remaining: records.length });
    });

    // -----------------------------------------------------------------------
    // Character summaries (world-scoped)
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file  = path.join(worldCharRoot(req, avatarId, worldTag, name), 'summaries.jsonl');
        const all   = readJsonl(file);
        const limit = Math.min(1000, parseInt(req.query.limit, 10) || 10);
        res.json(all.slice(-limit));
    });

    router.post('/personas/:avatarId/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file   = path.join(worldCharRoot(req, avatarId, worldTag, name), 'summaries.jsonl');
        const record = { ts: new Date().toISOString(), ...req.body };
        appendJsonl(file, record);
        res.json(record);
    });

    router.delete('/personas/:avatarId/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        writeJsonl(path.join(worldCharRoot(req, avatarId, worldTag, name), 'summaries.jsonl'), []);
        console.log(`[PAC] Cleared summaries: ${avatarId}/${worldTag}/${name}`);
        res.json({ cleared: true });
    });

    router.delete('/personas/:avatarId/worlds/:worldTag/characters/:name/summaries/:index', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!avatarId || !worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        const file    = path.join(worldCharRoot(req, avatarId, worldTag, name), 'summaries.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records.splice(index, 1);
        writeJsonl(file, records);
        res.json({ deleted: index, remaining: records.length });
    });

    // Update summary text by index (preserves ts and other metadata)
    router.patch('/personas/:avatarId/worlds/:worldTag/characters/:name/summaries/:index', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!avatarId || !worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        if (typeof req.body.summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
        const file    = path.join(worldCharRoot(req, avatarId, worldTag, name), 'summaries.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records[index] = { ...records[index], summary: req.body.summary };
        writeJsonl(file, records);
        res.json(records[index]);
    });

    // -----------------------------------------------------------------------
    // Bulk-delete events by index array
    // -----------------------------------------------------------------------

    router.post('/personas/:avatarId/worlds/:worldTag/characters/:name/events/bulk-delete', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });

        const { indices } = req.body;
        if (!Array.isArray(indices)) return res.status(400).json({ error: 'indices must be an array' });

        const file    = path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl');
        const records = readJsonl(file);
        // Remove in descending order so earlier indices remain valid
        const sorted  = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < records.length).sort((a, b) => b - a);
        for (const i of sorted) records.splice(i, 1);
        writeJsonl(file, records);
        res.json({ deleted: sorted.length, remaining: records.length });
    });

    // -----------------------------------------------------------------------
    // BM25 event search (world-scoped, server-side — no external deps)
    // -----------------------------------------------------------------------

    router.post('/personas/:avatarId/worlds/:worldTag/characters/:name/events/search', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });

        const { query, topK = 5 } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const file   = path.join(worldCharRoot(req, avatarId, worldTag, name), 'events.jsonl');
        const events = readJsonl(file);
        const results = bm25Search(events, query, Math.min(20, parseInt(topK, 10) || 5));
        res.json(results);
    });

    // -----------------------------------------------------------------------
    // Delete single character within a world
    // -----------------------------------------------------------------------

    router.delete('/personas/:avatarId/worlds/:worldTag/characters/:name', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!avatarId || !worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const dir = path.join(worldCharRoot(req, avatarId, worldTag, name));
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[PAC] Deleted character: ${avatarId}/${worldTag}/${name}`);
            res.json({ deleted: name });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // -----------------------------------------------------------------------
    // Export persona memory as a JSON bundle
    // -----------------------------------------------------------------------

    router.get('/personas/:avatarId/export', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });

        const pRoot = personaRoot(req, avatarId);
        if (!fs.existsSync(pRoot)) return res.status(404).json({ error: 'Persona not found' });

        try {
            const bundle = { version: 1, avatarId, exportedAt: new Date().toISOString(), worlds: {} };
            const worldsDir = path.join(pRoot, 'worlds');
            if (fs.existsSync(worldsDir)) {
                for (const worldTag of fs.readdirSync(worldsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
                    const wRoot = path.join(worldsDir, worldTag);
                    bundle.worlds[worldTag] = {
                        worldIdentity: readJson(path.join(wRoot, 'identity.json'), null),
                        characters: {},
                    };
                    const charsDir = path.join(wRoot, 'characters');
                    if (fs.existsSync(charsDir)) {
                        for (const charName of fs.readdirSync(charsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
                            const cRoot = path.join(charsDir, charName);
                            bundle.worlds[worldTag].characters[charName] = {
                                identity:  readJson(path.join(cRoot, 'identity.json'), null),
                                events:    readJsonl(path.join(cRoot, 'events.jsonl')),
                                summaries: readJsonl(path.join(cRoot, 'summaries.jsonl')),
                            };
                        }
                    }
                }
            }
            res.setHeader('Content-Disposition', `attachment; filename="pac-${avatarId}-${Date.now()}.json"`);
            res.json(bundle);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // -----------------------------------------------------------------------
    // Import persona memory from a JSON bundle
    // -----------------------------------------------------------------------

    router.post('/personas/:avatarId/import', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        if (!avatarId) return res.status(400).json({ error: 'Invalid avatarId' });

        const bundle = req.body;
        if (!bundle || bundle.version !== 1 || typeof bundle.worlds !== 'object') {
            return res.status(400).json({ error: 'Invalid bundle format' });
        }

        const overwrite = req.query.mode === 'overwrite';
        let written = 0;

        try {
            for (const [worldTag, worldData] of Object.entries(bundle.worlds)) {
                const safeWorld = sanitizeName(worldTag);
                if (!safeWorld) continue;
                const wRoot = worldRoot(req, avatarId, safeWorld);

                if (worldData.worldIdentity) {
                    const f = path.join(wRoot, 'identity.json');
                    if (overwrite || !fs.existsSync(f)) { writeJson(f, worldData.worldIdentity); written++; }
                }

                for (const [charName, charData] of Object.entries(worldData.characters || {})) {
                    const safeChar = sanitizeName(charName);
                    if (!safeChar) continue;
                    const cRoot = worldCharRoot(req, avatarId, safeWorld, safeChar);

                    if (charData.identity) {
                        const f = path.join(cRoot, 'identity.json');
                        if (overwrite || !fs.existsSync(f)) { writeJson(f, charData.identity); written++; }
                    }
                    if (Array.isArray(charData.events) && charData.events.length) {
                        const f = path.join(cRoot, 'events.jsonl');
                        if (overwrite || !fs.existsSync(f)) { writeJsonl(f, charData.events); written++; }
                    }
                    if (Array.isArray(charData.summaries) && charData.summaries.length) {
                        const f = path.join(cRoot, 'summaries.jsonl');
                        if (overwrite || !fs.existsSync(f)) { writeJsonl(f, charData.summaries); written++; }
                    }
                }
            }
            console.log(`[PAC] Import complete for ${avatarId}: ${written} file(s) written`);
            res.json({ imported: true, filesWritten: written });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // -----------------------------------------------------------------------
    // Shared world pool — identity, events, summaries (persistentWorld = ON)
    // Storage: data/{user}/extensions/pac/worlds/{worldTag}/...
    // -----------------------------------------------------------------------

    router.get('/worlds/:worldTag/identity', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        if (!worldTag) return res.status(400).json({ error: 'Invalid worldTag' });
        res.json(readJson(path.join(sharedWorldRoot(req, worldTag), 'identity.json'), {}));
    });

    router.post('/worlds/:worldTag/identity', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        if (!worldTag) return res.status(400).json({ error: 'Invalid worldTag' });
        const file = path.join(sharedWorldRoot(req, worldTag), 'identity.json');
        const data = { ...req.body, lastUpdated: new Date().toISOString() };
        writeJson(file, data);
        res.json(data);
    });

    router.get('/worlds/:worldTag/characters/:name/identity', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        res.json(readJson(path.join(sharedCharRoot(req, worldTag, name), 'identity.json'), {}));
    });

    router.post('/worlds/:worldTag/characters/:name/identity', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(sharedCharRoot(req, worldTag, name), 'identity.json');
        const data = { ...req.body, lastUpdated: new Date().toISOString() };
        writeJson(file, data);
        res.json(data);
    });

    router.get('/worlds/:worldTag/characters/:name/events', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file   = path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl');
        const all    = readJsonl(file);
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit  = Math.min(1000, parseInt(req.query.limit, 10) || 200);
        res.json(all.slice(offset, offset + limit));
    });

    router.post('/worlds/:worldTag/characters/:name/events', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file = path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl');
        if (req.body.event) {
            const existing = readJsonl(file);
            const recentTexts = new Set(existing.slice(-200).map(e => e.event));
            if (recentTexts.has(req.body.event)) return res.json({ duplicate: true, skipped: true });
        }
        const record = { ts: new Date().toISOString(), ...req.body };
        appendJsonl(file, record);
        res.json(record);
    });

    router.delete('/worlds/:worldTag/characters/:name/events', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        writeJsonl(path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl'), []);
        console.log(`[PAC] Cleared shared events: ${worldTag}/${name}`);
        res.json({ cleared: true });
    });

    router.delete('/worlds/:worldTag/characters/:name/events/:index', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        const file    = path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records.splice(index, 1);
        writeJsonl(file, records);
        res.json({ deleted: index, remaining: records.length });
    });

    router.post('/worlds/:worldTag/characters/:name/events/bulk-delete', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const { indices } = req.body;
        if (!Array.isArray(indices)) return res.status(400).json({ error: 'indices must be an array' });
        const file    = path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl');
        const records = readJsonl(file);
        const sorted  = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < records.length).sort((a, b) => b - a);
        for (const i of sorted) records.splice(i, 1);
        writeJsonl(file, records);
        res.json({ deleted: sorted.length, remaining: records.length });
    });

    router.post('/worlds/:worldTag/characters/:name/events/search', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const { query, topK = 5 } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });
        const file   = path.join(sharedCharRoot(req, worldTag, name), 'events.jsonl');
        const events = readJsonl(file);
        const results = bm25Search(events, query, Math.min(20, parseInt(topK, 10) || 5));
        res.json(results);
    });

    router.get('/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file  = path.join(sharedCharRoot(req, worldTag, name), 'summaries.jsonl');
        const all   = readJsonl(file);
        const limit = Math.min(1000, parseInt(req.query.limit, 10) || 10);
        res.json(all.slice(-limit));
    });

    router.post('/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        const file   = path.join(sharedCharRoot(req, worldTag, name), 'summaries.jsonl');
        const record = { ts: new Date().toISOString(), ...req.body };
        appendJsonl(file, record);
        res.json(record);
    });

    router.delete('/worlds/:worldTag/characters/:name/summaries', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        if (!worldTag || !name) return res.status(400).json({ error: 'Invalid params' });
        writeJsonl(path.join(sharedCharRoot(req, worldTag, name), 'summaries.jsonl'), []);
        console.log(`[PAC] Cleared shared summaries: ${worldTag}/${name}`);
        res.json({ cleared: true });
    });

    router.delete('/worlds/:worldTag/characters/:name/summaries/:index', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        const file    = path.join(sharedCharRoot(req, worldTag, name), 'summaries.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records.splice(index, 1);
        writeJsonl(file, records);
        res.json({ deleted: index, remaining: records.length });
    });

    router.patch('/worlds/:worldTag/characters/:name/summaries/:index', (req, res) => {
        const worldTag = sanitizeName(req.params.worldTag);
        const name     = sanitizeName(req.params.name);
        const index    = parseInt(req.params.index, 10);
        if (!worldTag || !name || isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid params' });
        if (typeof req.body.summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
        const file    = path.join(sharedCharRoot(req, worldTag, name), 'summaries.jsonl');
        const records = readJsonl(file);
        if (index >= records.length) return res.status(404).json({ error: 'Index out of range' });
        records[index] = { ...records[index], summary: req.body.summary };
        writeJsonl(file, records);
        res.json(records[index]);
    });

    // -----------------------------------------------------------------------
    // Delete entire world
    // -----------------------------------------------------------------------

    router.delete('/personas/:avatarId/worlds/:worldTag', (req, res) => {
        const avatarId = sanitizeName(req.params.avatarId);
        const worldTag = sanitizeName(req.params.worldTag);
        if (!avatarId || !worldTag) return res.status(400).json({ error: 'Invalid params' });
        const dir = path.join(personaRoot(req, avatarId), 'worlds', worldTag);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[PAC] Deleted world: ${avatarId}/${worldTag}`);
            res.json({ deleted: worldTag });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
}

export async function exit() {}
