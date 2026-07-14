/**
 * Vertex Scoring - Event/Division Score Server
 *
 * Reads Event, Division, and Pool options from scoring_page.html.
 * Creates a SCORES folder with one JSON file for every Event + Division pair.
 * Creates a FEEDBACK folder with one JSON file for tournament feedback.
 * Saves each submitted score inside the selected pool for that Event + Division.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || process.env.BIND_HOST || '127.0.0.1';
const HTML_FILE = path.join(__dirname, 'scoring_page.html');
const LOGIN_FILE = path.join(__dirname, 'admin_login.html');
const CREDENTIALS_FILE = path.join(__dirname, 'cred_vertex.json');
const LIVE_SCORE_SETTINGS_FILE = path.join(__dirname, 'live_score_settings.json');
const SCORES_DIR = path.join(__dirname, 'SCORES');
const FEEDBACK_DIR = path.join(__dirname, 'FEEDBACK');
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'feedback.json');
const LEGACY_FEEDBACK_FILE = path.join(__dirname, 'feedback.js');
const BRACKET_POSTERS_FILE = path.join(__dirname, 'VERTEX_Bracket_Posters.html');
const TOURNAMENT_DATA_FILE = path.join(__dirname, 'tournament_data.json');
const ROUND_POOL = 'Pool';
const ROUND_SUPER_POOL = 'Super-pool';
const ROUND_SEMI_FINAL = 'Semi Final';
const ROUND_FINAL = 'Final';
const ROUND_KEYS = {
    [ROUND_SEMI_FINAL]: 'semiFinal',
    [ROUND_FINAL]: 'final'
};
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_HASH_KEY_LENGTH = 64;
const PASSWORD_HASH_OPTIONS = {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
};
const ADMIN_SESSION_COOKIE = 'vertex_admin_session';
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

function decodeHtml(value) {
    return String(value)
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&rsquo;/g, "'")
        .replace(/&lsquo;/g, "'")
        .replace(/&eacute;/g, '\u00e9')
        .replace(/&Eacute;/g, '\u00c9')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripTags(value) {
    return decodeHtml(String(value).replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDivision(value) {
    const numbers = String(value).match(/\d+/g) || [];
    if (numbers.length >= 3) return `${numbers[0]}-${numbers[numbers.length - 1]}`;
    if (numbers.length >= 2) return `${numbers[0]}-${numbers[1]}`;
    return String(value).trim();
}

function extractEvent(title) {
    const cleanTitle = stripTags(title);
    const events = [
        "Men's Doubles",
        "Women's Doubles",
        'Mixed Doubles',
        "Men's Singles",
        "Women's Singles"
    ];

    return events.find(event => cleanTitle.includes(event)) || '';
}

function extractTeamName(teamHtml) {
    return decodeHtml(String(teamHtml)
        .replace(/<span\b[^>]*class=["']ci["'][^>]*>[\s\S]*?<\/span>/gi, '')
        .replace(/<br\s*\/?>/gi, ' / ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim());
}

function parseTournamentBracketPosters(html) {
    const pageChunks = String(html).split(/<div\s+class=["']page["'][^>]*>/i).slice(1);
    const categories = [];

    pageChunks.forEach(pageHtml => {
        const titleMatch = pageHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
        const title = titleMatch ? stripTags(titleMatch[1]) : '';
        const event = extractEvent(title);
        const divisionMatch = title.match(/Division\s+([0-9-]+)/i);
        const division = divisionMatch ? normalizeDivision(divisionMatch[1]) : '';
        const gradeMatch = title.match(/Grade\s+([^/]+)\s*\/\s*Division/i);
        const grade = gradeMatch ? gradeMatch[1].trim() : '';

        if (!event || !division) return;

        const pools = [];
        const poolPattern = /<div\s+class=["']pc["'][^>]*>\s*<div\s+class=["']pc-h["'][^>]*>\s*POOL\s+([A-Z])\s*\((\d+)\s+TEAMS?\)\s*<\/div>\s*<div\s+class=["']pc-b["'][^>]*>([\s\S]*?)<\/div>\s*<div\s+class=["']pq["'][^>]*>/gi;
        let poolMatch;

        while ((poolMatch = poolPattern.exec(pageHtml)) !== null) {
            const pool = poolMatch[1];
            const teamsPerPool = Number(poolMatch[2]);
            const poolBody = poolMatch[3];
            const teams = [];
            const teamPattern = /<div\s+class=["']pt["'][^>]*>[\s\S]*?<div\s+class=["']pi["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            let teamMatch;

            while ((teamMatch = teamPattern.exec(poolBody)) !== null) {
                const name = extractTeamName(teamMatch[1]);
                if (name) teams.push(name);
            }

            pools.push({
                pool,
                teamsPerPool,
                teams
            });
        }

        if (pools.length > 0) {
            categories.push({
                event,
                division,
                grade,
                title,
                pools
            });
        }
    });

    return {
        source: path.basename(BRACKET_POSTERS_FILE),
        generatedAt: new Date().toISOString(),
        categories
    };
}

function readSelectOptions(html, selectId) {
    const selectPattern = new RegExp(`<select\\b[^>]*id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i');
    const selectMatch = html.match(selectPattern);

    if (!selectMatch) {
        throw new Error(`Could not find select field: ${selectId}`);
    }

    const options = [];
    const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;

    while ((optionMatch = optionPattern.exec(selectMatch[1])) !== null) {
        const attrs = optionMatch[1];
        const label = optionMatch[2].replace(/<[^>]+>/g, '').trim();
        const valueMatch = attrs.match(/\bvalue\s*=\s*(["'])(.*?)\1/i);
        const value = decodeHtml(valueMatch ? valueMatch[2] : label);

        if (value) options.push(value);
    }

    if (options.length === 0) {
        throw new Error(`No options found for select field: ${selectId}`);
    }

    return options;
}

function readScoringPageConfig() {
    const html = fs.readFileSync(HTML_FILE, 'utf8');

    return {
        events: readSelectOptions(html, 'eventType'),
        divisions: readSelectOptions(html, 'division'),
        pools: readSelectOptions(html, 'pool')
    };
}

function slugify(value) {
    return String(value)
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'value';
}

function getScoreFilePath(event, division) {
    return path.join(SCORES_DIR, `${slugify(event)}__division_${slugify(division)}.json`);
}

function buildEmptyScoreFile(event, division, pools) {
    const poolData = {};
    pools.forEach(pool => {
        poolData[pool] = [];
    });

    return {
        event,
        division,
        pools: poolData,
        rounds: {}
    };
}

function normalizeScoreFile(existing, event, division, pools) {
    const normalized = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};

    normalized.event = normalized.event || event;
    normalized.division = normalized.division || division;
    normalized.pools = normalized.pools && typeof normalized.pools === 'object' && !Array.isArray(normalized.pools)
        ? normalized.pools
        : {};

    pools.forEach(pool => {
        if (!Array.isArray(normalized.pools[pool])) {
            normalized.pools[pool] = [];
        }
    });

    normalized.rounds = normalized.rounds && typeof normalized.rounds === 'object' && !Array.isArray(normalized.rounds)
        ? normalized.rounds
        : {};

    return normalized;
}

function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

// File-level write locks to prevent concurrent write corruption
const fileLocks = new Map();

function acquireFileLock(filePath) {
    return new Promise(resolve => {
        const queue = fileLocks.get(filePath);
        if (queue && queue.length > 0) {
            queue.push(resolve);
        } else {
            fileLocks.set(filePath, []);
            resolve();
        }
    });
}

function releaseFileLock(filePath) {
    const queue = fileLocks.get(filePath);
    if (queue && queue.length > 0) {
        const next = queue.shift();
        next();
    } else {
        fileLocks.delete(filePath);
    }
}

function writeJsonFile(filePath, data) {
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);
}

function readLegacyFeedbackEntries() {
    if (!fs.existsSync(LEGACY_FEEDBACK_FILE)) return [];

    const content = fs.readFileSync(LEGACY_FEEDBACK_FILE, 'utf8');
    const match = content.match(/window\.vertexFeedback\s*=\s*(\[[\s\S]*?\])\s*;?\s*$/);
    if (!match) return [];

    try {
        const entries = JSON.parse(match[1]);
        return Array.isArray(entries) ? entries : [];
    } catch (error) {
        return [];
    }
}

function readFeedbackEntries() {
    return readJsonFile(FEEDBACK_FILE, []).filter(entry => entry && typeof entry === 'object');
}

function writeFeedbackEntries(entries) {
    fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
    writeJsonFile(FEEDBACK_FILE, entries);
}

function ensureFeedbackFile() {
    fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
    if (!fs.existsSync(FEEDBACK_FILE)) {
        writeFeedbackEntries(readLegacyFeedbackEntries());
    }
}

function cleanFeedbackText(value, maxLength) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanFeedbackMessage(value, maxLength) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim()
        .slice(0, maxLength);
}

function cleanFeedbackRating(value) {
    const rating = Number.parseInt(value, 10);
    return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function getPublicFeedbackEntries() {
    return readFeedbackEntries()
        .filter(entry => entry && typeof entry === 'object' && entry.approved === true && cleanFeedbackMessage(entry.feedback, 260))
        .slice(-20)
        .reverse()
        .map(entry => ({
            id: cleanFeedbackText(entry.id, 80),
            submittedAt: cleanFeedbackText(entry.submittedAt, 40),
            name: cleanFeedbackText(entry.name, 50),
            clubOrTeam: cleanFeedbackText(entry.clubOrTeam, 70),
            overallRating: cleanFeedbackRating(entry.overallRating),
            feedback: cleanFeedbackMessage(entry.feedback, 260)
        }));
}

function getAdminFeedbackEntries() {
    return readFeedbackEntries()
        .map((entry, index) => ({
            index,
            id: cleanFeedbackText(entry?.id, 80),
            submittedAt: cleanFeedbackText(entry?.submittedAt, 40),
            name: cleanFeedbackText(entry?.name, 80),
            clubOrTeam: cleanFeedbackText(entry?.clubOrTeam, 120),
            role: cleanFeedbackText(entry?.role, 40),
            overallRating: cleanFeedbackRating(entry?.overallRating),
            organizationRating: cleanFeedbackRating(entry?.organizationRating),
            scheduleRating: cleanFeedbackRating(entry?.scheduleRating),
            venueRating: cleanFeedbackRating(entry?.venueRating),
            wouldReturn: cleanFeedbackText(entry?.wouldReturn, 20),
            feedback: cleanFeedbackMessage(entry?.feedback, 2000),
            suggestions: cleanFeedbackMessage(entry?.suggestions, 2000),
            approved: entry?.approved === true,
            approvedAt: cleanFeedbackText(entry?.approvedAt, 40)
        }))
        .reverse();
}

function normalizeLiveRefreshSeconds(value) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds)) return 15;
    return Math.max(1, Math.min(300, seconds));
}

function readLiveScoreSettings() {
    const settings = readJsonFile(LIVE_SCORE_SETTINGS_FILE, {});
    return {
        refreshSeconds: normalizeLiveRefreshSeconds(settings.refreshSeconds)
    };
}

async function handleLiveScoreSettings(req, res) {
    if (req.method === 'GET') {
        sendJson(res, 200, readLiveScoreSettings());
        return;
    }

    try {
        const body = await collectRequestBody(req);
        const settings = JSON.parse(body || '{}');
        const savedSettings = {
            refreshSeconds: normalizeLiveRefreshSeconds(settings.refreshSeconds)
        };
        writeJsonFile(LIVE_SCORE_SETTINGS_FILE, savedSettings);
        sendJson(res, 200, { status: 'success', ...savedSettings });
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: 'Refresh setting could not be saved.' });
    }
}

function ensureScoreFiles(config) {
    fs.mkdirSync(SCORES_DIR, { recursive: true });

    config.events.forEach(event => {
        config.divisions.forEach(division => {
            const filePath = getScoreFilePath(event, division);
            const existing = fs.existsSync(filePath)
                ? readJsonFile(filePath, buildEmptyScoreFile(event, division, config.pools))
                : buildEmptyScoreFile(event, division, config.pools);
            const normalized = normalizeScoreFile(existing, event, division, config.pools);

            writeJsonFile(filePath, normalized);
        });
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function getRequestUrl(req) {
    const fallbackHost = `${HOST}:${PORT}`;
    return new URL(req.url, `http://${req.headers.host || fallbackHost}`);
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    return Object.fromEntries(header
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const separatorIndex = part.indexOf('=');
            if (separatorIndex === -1) return [part, ''];
            return [
                decodeURIComponent(part.slice(0, separatorIndex)),
                decodeURIComponent(part.slice(separatorIndex + 1))
            ];
        }));
}

function readCredentials() {
    const credentials = readJsonFile(CREDENTIALS_FILE, {});
    if (Array.isArray(credentials.admins)) return credentials.admins;
    if (credentials.username && credentials.password) {
        return [{ username: credentials.username, password: credentials.password }];
    }
    if (credentials.admin_username && credentials.admin_password) {
        return [{ username: credentials.admin_username, password: credentials.admin_password }];
    }
    return [];
}

function hashAdminPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(
        String(password || ''),
        salt,
        PASSWORD_HASH_KEY_LENGTH,
        PASSWORD_HASH_OPTIONS
    ).toString('hex');

    return [
        PASSWORD_HASH_PREFIX,
        PASSWORD_HASH_OPTIONS.N,
        PASSWORD_HASH_OPTIONS.r,
        PASSWORD_HASH_OPTIONS.p,
        salt,
        hash
    ].join('$');
}

function verifyPasswordHash(password, storedHash) {
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_PREFIX) return false;

    const [, nValue, rValue, pValue, salt, expectedHash] = parts;
    const options = {
        N: Number.parseInt(nValue, 10),
        r: Number.parseInt(rValue, 10),
        p: Number.parseInt(pValue, 10),
        maxmem: PASSWORD_HASH_OPTIONS.maxmem
    };

    if (!options.N || !options.r || !options.p || !salt || !expectedHash) return false;

    try {
        const actual = crypto.scryptSync(
            String(password || ''),
            salt,
            PASSWORD_HASH_KEY_LENGTH,
            options
        );
        const expected = Buffer.from(expectedHash, 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (error) {
        return false;
    }
}

function verifyAdminPassword(admin, password) {
    if (admin.passwordHash) {
        return verifyPasswordHash(password, admin.passwordHash);
    }

    return String(admin.password || '') === String(password || '');
}

function validateAdminCredentials(username, password) {
    return readCredentials().some(admin => (
        String(admin.username || '') === String(username || '') &&
        verifyAdminPassword(admin, password)
    ));
}

function cleanupAdminSessions() {
    const now = Date.now();
    adminSessions.forEach((session, token) => {
        if (!session || session.expiresAt <= now) {
            adminSessions.delete(token);
        }
    });
}

function isAdminAuthenticated(req) {
    cleanupAdminSessions();
    const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
    const session = token ? adminSessions.get(token) : null;
    return Boolean(session && session.expiresAt > Date.now());
}

function setAdminSession(res, username) {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, {
        username,
        expiresAt: Date.now() + ADMIN_SESSION_MS
    });
    res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}`);
}

function clearAdminSession(req, res) {
    const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

async function handleAdminLogin(req, res) {
    try {
        const body = await collectRequestBody(req);
        const credentials = JSON.parse(body || '{}');
        if (!validateAdminCredentials(credentials.username, credentials.password)) {
            sendJson(res, 401, { status: 'error', message: 'Invalid admin username or password.' });
            return;
        }

        const requestedRedirect = String(credentials.redirect || '');
        const redirect = /^\/(?:vertexadmin|scoring_page|adminfeedback)(?:\.html)?$/i.test(requestedRedirect)
            ? requestedRedirect
            : '/vertexadmin.html';
        setAdminSession(res, credentials.username);
        sendJson(res, 200, { status: 'success', redirect });
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: 'Login request could not be processed.' });
    }
}

function requireAdmin(req, res) {
    if (isAdminAuthenticated(req)) return true;
    sendJson(res, 401, { status: 'error', message: 'Admin login required.' });
    return false;
}

function collectRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        const timeout = setTimeout(() => {
            reject(new Error('Request body read timed out'));
            req.destroy();
        }, 15000);

        req.on('data', chunk => {
            body += chunk;
            if (body.length > 10 * 1024 * 1024) {
                clearTimeout(timeout);
                reject(new Error('Request body is too large'));
                req.destroy();
            }
        });
        req.on('end', () => { clearTimeout(timeout); resolve(body); });
        req.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

function normalizeRound(round, pool) {
    if (round === ROUND_SUPER_POOL || round === ROUND_SEMI_FINAL || round === ROUND_FINAL) {
        return round;
    }
    if (/^SF[12]$/i.test(pool || '')) return ROUND_SEMI_FINAL;
    if (/^[XY]$/i.test(pool || '')) return ROUND_SUPER_POOL;
    return ROUND_POOL;
}

function isKnockoutRound(round) {
    return round === ROUND_SEMI_FINAL || round === ROUND_FINAL;
}

function getEntriesForScoreContext(scoreFile, round, pool) {
    if (isKnockoutRound(round)) {
        const roundKey = ROUND_KEYS[round];
        const roundEntries = scoreFile.rounds && scoreFile.rounds[roundKey];
        return roundEntries && Array.isArray(roundEntries[pool]) ? roundEntries[pool] : [];
    }

    return scoreFile.pools && Array.isArray(scoreFile.pools[pool])
        ? scoreFile.pools[pool]
        : [];
}

function getLatestSavedAtForContext(scoreFile, round, pool) {
    const entries = getEntriesForScoreContext(scoreFile, round, pool);
    const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    return typeof latestEntry?.savedAt === 'string' && latestEntry.savedAt ? latestEntry.savedAt : null;
}

function hasFilledScoreValue(score) {
    return score?.games !== null && score?.games !== undefined && score?.games !== '' ||
        score?.points !== null && score?.points !== undefined && score?.points !== '';
}

function buildScoreMapForEntry(entry) {
    const map = new Map();
    const expectedSets = Number(entry?.setsPerMatch) || 0;
    (entry?.scores || []).forEach(score => {
        const key = `${score.team}-${score.opponent}`;
        const record = map.get(key) || { games: 0, points: 0, sets: [], expectedSets };
        const games = Number(score.games) || 0;
        const points = Number(score.points) || 0;
        record.games += games;
        record.points += points;
        record.expectedSets = Math.max(record.expectedSets || 0, expectedSets);
        record.sets.push({
            set: Number(score.set) || 0,
            games,
            points,
            complete: hasFilledScoreValue(score)
        });
        map.set(key, record);
    });
    return map;
}

function getEntryMatchResult(scoreMap, firstTeam, secondTeam) {
    const firstScore = scoreMap.get(`${firstTeam}-${secondTeam}`) || { games: 0, points: 0, sets: [], expectedSets: 0 };
    const secondScore = scoreMap.get(`${secondTeam}-${firstTeam}`) || { games: 0, points: 0, sets: [], expectedSets: 0 };
    const expectedSets = Math.max(firstScore.expectedSets || 0, secondScore.expectedSets || 0, firstScore.sets?.length || 0, secondScore.sets?.length || 0);
    const neededGames = expectedSets ? Math.floor(expectedSets / 2) + 1 : 1;
    const completedSets = new Set(
        (firstScore.sets || [])
            .filter(firstSet => {
                const setNumber = Number(firstSet.set) || 0;
                const secondSet = (secondScore.sets || []).find(item => Number(item.set) === setNumber);
                return setNumber && firstSet.complete && secondSet?.complete;
            })
            .map(item => Number(item.set))
    );
    const allExpectedSetsComplete = expectedSets > 0 && completedSets.size >= expectedSets;
    const matchDecided = firstScore.games >= neededGames || secondScore.games >= neededGames;
    const played = allExpectedSetsComplete || matchDecided;
    let winner = null;

    if (played) {
        if (firstScore.games > secondScore.games) winner = firstTeam;
        if (secondScore.games > firstScore.games) winner = secondTeam;
    }

    return { played, winner };
}

function getDecidedEntryWinnerSeed(entry) {
    const teams = Array.isArray(entry?.teams) ? entry.teams : [];
    if (teams.length < 2) return null;

    const scoreMap = buildScoreMapForEntry(entry);
    for (let teamIndex = 1; teamIndex <= teams.length; teamIndex++) {
        let wins = 0;

        for (let opponent = 1; opponent <= teams.length; opponent++) {
            if (opponent === teamIndex) continue;
            const result = getEntryMatchResult(scoreMap, teamIndex, opponent);
            if (result.played && result.winner === teamIndex) wins += 1;
        }

        if (wins >= teams.length - 1) return teamIndex;
    }

    return null;
}

function hasScoresOutsideWinnerMatch(entry, winnerSeed) {
    const winningSeed = Number(winnerSeed) || 0;
    if (!winningSeed) return false;

    return (entry?.scores || []).some(score => (
        hasFilledScoreValue(score) &&
        Number(score.team) !== winningSeed &&
        Number(score.opponent) !== winningSeed
    ));
}

function validateSubmittedScore(score, config) {
    if (!config.events.includes(score.event)) {
        throw new Error(`Unknown event: ${score.event}`);
    }
    if (!config.divisions.includes(score.division)) {
        throw new Error(`Unknown division: ${score.division}`);
    }

    const round = normalizeRound(score.round, score.pool);
    if (round === ROUND_SEMI_FINAL && !/^SF[12]$/i.test(score.pool || '')) {
        throw new Error(`Unknown semi-final match: ${score.pool}`);
    }
    if (round === ROUND_FINAL && !/^F$/i.test(score.pool || '')) {
        throw new Error(`Unknown final match: ${score.pool}`);
    }
    if (!isKnockoutRound(round) && !config.pools.includes(score.pool) && !/^[A-Z]$/.test(score.pool)) {
        throw new Error(`Unknown pool: ${score.pool}`);
    }
}

async function handleSave(req, res, config) {
    let filePath = null;
    try {
        const body = await collectRequestBody(req);
        const newEntry = JSON.parse(body);

        validateSubmittedScore(newEntry, config);
        newEntry.round = normalizeRound(newEntry.round, newEntry.pool);
        newEntry.match = isKnockoutRound(newEntry.round) ? newEntry.pool : '';
        newEntry.savedAt = new Date().toISOString();

        filePath = getScoreFilePath(newEntry.event, newEntry.division);
        await acquireFileLock(filePath);
        const existing = readJsonFile(
            filePath,
            buildEmptyScoreFile(newEntry.event, newEntry.division, config.pools)
        );
        const scoreFile = normalizeScoreFile(existing, newEntry.event, newEntry.division, config.pools);
        let savedEntries;

        const clientBaseSavedAt = typeof newEntry.baseSavedAt === 'string' && newEntry.baseSavedAt
            ? newEntry.baseSavedAt
            : null;
        const latestSavedAt = getLatestSavedAtForContext(scoreFile, newEntry.round, newEntry.pool);
        if (latestSavedAt !== clientBaseSavedAt) {
            sendJson(res, 409, {
                status: 'conflict',
                message: `This ${newEntry.round} ${newEntry.pool} score sheet was saved by another admin after you loaded it. Reload the latest scores before saving.`,
                round: newEntry.round,
                pool: newEntry.pool,
                latestSavedAt,
                baseSavedAt: clientBaseSavedAt
            });
            console.log(`[${new Date().toLocaleTimeString()}] Blocked stale save ${newEntry.event} / ${newEntry.division} / ${newEntry.round} ${newEntry.pool}`);
            return;
        }
        delete newEntry.baseSavedAt;

        if (
            newEntry.round === ROUND_SUPER_POOL &&
            !newEntry.clearEntry &&
            /^[XY]$/i.test(newEntry.pool || '')
        ) {
            const entries = getEntriesForScoreContext(scoreFile, newEntry.round, newEntry.pool);
            const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
            const winnerSeed = getDecidedEntryWinnerSeed(latestEntry);

            if (winnerSeed && hasScoresOutsideWinnerMatch(newEntry, winnerSeed)) {
                sendJson(res, 400, {
                    status: 'error',
                    message: `Super-pool ${newEntry.pool} already has a decided winner. The remaining non-winner match should not be saved.`,
                    round: newEntry.round,
                    pool: newEntry.pool
                });
                console.log(`[${new Date().toLocaleTimeString()}] Blocked non-winner super-pool save ${newEntry.event} / ${newEntry.division} / ${newEntry.round} ${newEntry.pool}`);
                return;
            }
        }

        if (isKnockoutRound(newEntry.round)) {
            const roundKey = ROUND_KEYS[newEntry.round];
            if (!scoreFile.rounds[roundKey] || typeof scoreFile.rounds[roundKey] !== 'object' || Array.isArray(scoreFile.rounds[roundKey])) {
                scoreFile.rounds[roundKey] = {};
            }
            if (newEntry.clearEntry) {
                delete scoreFile.rounds[roundKey][newEntry.pool];
                savedEntries = [];
                writeJsonFile(filePath, scoreFile);
                sendJson(res, 200, {
                    status: 'success',
                    cleared: true,
                    message: `Cleared ${newEntry.round} ${newEntry.pool} from ${path.relative(__dirname, filePath)}`,
                    file: path.relative(__dirname, filePath),
                    round: newEntry.round,
                    pool: newEntry.pool,
                    totalEntries: 0
                });
                console.log(`[${new Date().toLocaleTimeString()}] Cleared ${newEntry.event} / ${newEntry.division} / ${newEntry.round} ${newEntry.pool}`);
                return;
            }
            if (!Array.isArray(scoreFile.rounds[roundKey][newEntry.pool])) {
                scoreFile.rounds[roundKey][newEntry.pool] = [];
            }
            scoreFile.rounds[roundKey][newEntry.pool].push(newEntry);
            savedEntries = scoreFile.rounds[roundKey][newEntry.pool];
        } else {
            if (newEntry.clearEntry) {
                scoreFile.pools[newEntry.pool] = [];
                savedEntries = [];
                writeJsonFile(filePath, scoreFile);
                sendJson(res, 200, {
                    status: 'success',
                    cleared: true,
                    message: `Cleared ${newEntry.round} ${newEntry.pool} from ${path.relative(__dirname, filePath)}`,
                    file: path.relative(__dirname, filePath),
                    round: newEntry.round,
                    pool: newEntry.pool,
                    totalEntries: 0
                });
                console.log(`[${new Date().toLocaleTimeString()}] Cleared ${newEntry.event} / ${newEntry.division} / ${newEntry.round} ${newEntry.pool}`);
                return;
            }
            if (!Array.isArray(scoreFile.pools[newEntry.pool])) {
                scoreFile.pools[newEntry.pool] = [];
            }
            scoreFile.pools[newEntry.pool].push(newEntry);
            savedEntries = scoreFile.pools[newEntry.pool];
        }

        writeJsonFile(filePath, scoreFile);

        sendJson(res, 200, {
            status: 'success',
            message: `Saved to ${path.relative(__dirname, filePath)}`,
            file: path.relative(__dirname, filePath),
            round: newEntry.round,
            pool: newEntry.pool,
            totalEntries: savedEntries.length
        });

        console.log(`[${new Date().toLocaleTimeString()}] Saved ${newEntry.event} / ${newEntry.division} / ${newEntry.round} ${newEntry.pool}`);
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: error.message });
        console.error(`[${new Date().toLocaleTimeString()}] Error: ${error.message}`);
    } finally {
        if (filePath) releaseFileLock(filePath);
    }
}

async function handleFeedbackSubmit(req, res) {
    try {
        const body = await collectRequestBody(req);
        const submitted = JSON.parse(body || '{}');

        const entry = {
            id: crypto.randomUUID(),
            submittedAt: new Date().toISOString(),
            approved: false,
            approvedAt: '',
            name: cleanFeedbackText(submitted.name, 80),
            clubOrTeam: cleanFeedbackText(submitted.clubOrTeam, 120),
            role: cleanFeedbackText(submitted.role, 40),
            overallRating: cleanFeedbackRating(submitted.overallRating),
            organizationRating: cleanFeedbackRating(submitted.organizationRating),
            scheduleRating: cleanFeedbackRating(submitted.scheduleRating),
            venueRating: cleanFeedbackRating(submitted.venueRating),
            wouldReturn: cleanFeedbackText(submitted.wouldReturn, 20),
            feedback: cleanFeedbackMessage(submitted.feedback, 2000),
            suggestions: cleanFeedbackMessage(submitted.suggestions, 2000)
        };

        if (!entry.overallRating) {
            throw new Error('Please choose an overall rating.');
        }

        if (!entry.feedback && !entry.suggestions) {
            throw new Error('Please add a feedback comment or suggestion.');
        }

        const entries = readFeedbackEntries();
        entries.push(entry);
        writeFeedbackEntries(entries);

        sendJson(res, 200, {
            status: 'success',
            message: `Feedback saved to ${path.basename(FEEDBACK_FILE)}`,
            file: path.relative(__dirname, FEEDBACK_FILE),
            totalEntries: entries.length
        });

        console.log(`[${new Date().toLocaleTimeString()}] Feedback saved (${entries.length} total)`);
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: error.message || 'Feedback could not be saved.' });
        console.error(`[${new Date().toLocaleTimeString()}] Feedback error: ${error.message}`);
    }
}

function handlePublicFeedback(res) {
    sendJson(res, 200, {
        status: 'success',
        feedback: getPublicFeedbackEntries()
    });
}

function handleAdminFeedbackList(res) {
    const feedback = getAdminFeedbackEntries();
    sendJson(res, 200, {
        status: 'success',
        feedback,
        totalEntries: feedback.length,
        pendingEntries: feedback.filter(entry => !entry.approved).length,
        approvedEntries: feedback.filter(entry => entry.approved).length
    });
}

async function handleAdminFeedbackApproval(req, res) {
    try {
        const body = await collectRequestBody(req);
        const submitted = JSON.parse(body || '{}');
        const index = Number.parseInt(submitted.index, 10);
        const approved = submitted.approved === true;
        const entries = readFeedbackEntries();

        if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
            throw new Error('Feedback item was not found.');
        }

        entries[index].approved = approved;
        entries[index].approvedAt = approved ? new Date().toISOString() : '';
        writeFeedbackEntries(entries);

        sendJson(res, 200, {
            status: 'success',
            approved,
            feedback: getAdminFeedbackEntries()
        });
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: error.message || 'Feedback approval could not be saved.' });
    }
}

function handleLoadTournamentData(res) {
    try {
        if (!fs.existsSync(BRACKET_POSTERS_FILE)) {
            throw new Error(`Missing ${path.basename(BRACKET_POSTERS_FILE)} in the project folder.`);
        }

        const html = fs.readFileSync(BRACKET_POSTERS_FILE, 'utf8');
        const data = parseTournamentBracketPosters(html);

        if (data.categories.length === 0) {
            throw new Error('No tournament categories were found in the bracket poster file.');
        }

        writeJsonFile(TOURNAMENT_DATA_FILE, data);

        sendJson(res, 200, {
            status: 'success',
            message: `Created ${path.basename(TOURNAMENT_DATA_FILE)} from ${path.basename(BRACKET_POSTERS_FILE)}`,
            file: path.relative(__dirname, TOURNAMENT_DATA_FILE),
            data
        });
    } catch (error) {
        sendJson(res, 500, { status: 'error', message: error.message });
    }
}

function handleLoad(req, res, config, requestedUrl) {
    try {
        const event = requestedUrl.searchParams.get('event') || '';
        const division = requestedUrl.searchParams.get('division') || '';
        const pool = requestedUrl.searchParams.get('pool') || '';
        const round = normalizeRound(requestedUrl.searchParams.get('round') || '', pool);
        const requestedSetsPerMatch = requestedUrl.searchParams.get('setsPerMatch');
        const lookup = { event, division, round, pool };

        validateSubmittedScore(lookup, config);

        const filePath = getScoreFilePath(event, division);
        const scoreFile = readJsonFile(
            filePath,
            buildEmptyScoreFile(event, division, config.pools)
        );
        const normalized = normalizeScoreFile(scoreFile, event, division, config.pools);
        const roundKey = ROUND_KEYS[round];
        const poolEntries = roundKey
            ? (normalized.rounds?.[roundKey]?.[pool] || [])
            : (normalized.pools[pool] || []);
        const matchingEntries = requestedSetsPerMatch
            ? poolEntries.filter(entry => String(entry.setsPerMatch) === requestedSetsPerMatch)
            : poolEntries;
        const selectedEntries = matchingEntries.length > 0 ? matchingEntries : poolEntries;
        const latestEntry = selectedEntries.length > 0 ? selectedEntries[selectedEntries.length - 1] : null;

        sendJson(res, 200, {
            status: 'success',
            file: path.relative(__dirname, filePath),
            round,
            pool,
            setsPerMatch: requestedSetsPerMatch || null,
            totalEntries: selectedEntries.length,
            entry: latestEntry
        });
    } catch (error) {
        sendJson(res, 400, { status: 'error', message: error.message });
    }
}

function handleScoreFiles(res, config) {
    const files = [];

    config.events.forEach(event => {
        config.divisions.forEach(division => {
            files.push({
                event,
                division,
                file: path.relative(__dirname, getScoreFilePath(event, division))
            });
        });
    });

    sendJson(res, 200, { scoresFolder: path.relative(__dirname, SCORES_DIR), files });
}

function sendNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function serveStaticFile(req, res) {
    const requestedUrl = getRequestUrl(req);
    const isAdminPagePath = requestedUrl.pathname === '/scoring_page' ||
        requestedUrl.pathname === '/scoring_page.html' ||
        requestedUrl.pathname === '/vertexadmin.html' ||
        requestedUrl.pathname === '/adminfeedback' ||
        requestedUrl.pathname === '/adminfeedback.html';
    const requestedPath = isAdminPagePath
        ? (requestedUrl.pathname === '/adminfeedback' ||
            requestedUrl.pathname === '/adminfeedback.html'
            ? '/adminfeedback.html'
            : '/scoring_page.html')
        : (requestedUrl.pathname === '/' ? '/index.html' : requestedUrl.pathname);
    const filePath = path.normalize(path.join(__dirname, requestedPath));

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    const requestedFileName = path.basename(filePath).toLowerCase();
    if (
        requestedFileName === path.basename(CREDENTIALS_FILE).toLowerCase() ||
        requestedFileName === path.basename(FEEDBACK_FILE).toLowerCase() ||
        requestedFileName === path.basename(LEGACY_FEEDBACK_FILE).toLowerCase()
    ) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    if (isAdminPagePath && !isAdminAuthenticated(req)) {
        fs.readFile(LOGIN_FILE, (error, content) => {
            if (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Admin login page is missing.');
                return;
            }

            sendNoStoreHeaders(res);
            res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
            res.end(content);
        });
        return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain; charset=utf-8';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('File not found: ' + requestedUrl.pathname);
            return;
        }

        if (isAdminPagePath) {
            sendNoStoreHeaders(res);
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
}

function createServer(config) {
    return http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const requestedUrl = getRequestUrl(req);

        if (req.method === 'POST' && requestedUrl.pathname === '/admin-login') {
            handleAdminLogin(req, res);
            return;
        }

        if (req.method === 'GET' && requestedUrl.pathname === '/admin-session-check') {
            if (isAdminAuthenticated(req)) {
                sendJson(res, 200, { status: 'active' });
            } else {
                sendJson(res, 401, { status: 'expired' });
            }
            return;
        }

        if ((req.method === 'POST' || req.method === 'GET') && requestedUrl.pathname === '/admin-logout') {
            clearAdminSession(req, res);
            if (req.method === 'GET') {
                res.writeHead(302, { Location: '/' });
                res.end();
            } else {
                sendJson(res, 200, { status: 'success' });
            }
            return;
        }

        if (requestedUrl.pathname === '/live-score-settings') {
            if (req.method === 'GET') {
                handleLiveScoreSettings(req, res);
                return;
            }
            if (req.method === 'POST') {
                if (!requireAdmin(req, res)) return;
                handleLiveScoreSettings(req, res);
                return;
            }
        }

        if (req.method === 'POST' && requestedUrl.pathname === '/save') {
            if (!requireAdmin(req, res)) return;
            handleSave(req, res, config);
            return;
        }

        if (req.method === 'POST' && requestedUrl.pathname === '/submit-feedback') {
            handleFeedbackSubmit(req, res);
            return;
        }

        if (req.method === 'GET' && requestedUrl.pathname === '/public-feedback') {
            handlePublicFeedback(res);
            return;
        }

        if (req.method === 'GET' && requestedUrl.pathname === '/admin-feedback') {
            if (!requireAdmin(req, res)) return;
            handleAdminFeedbackList(res);
            return;
        }

        if (req.method === 'POST' && requestedUrl.pathname === '/admin-feedback-approval') {
            if (!requireAdmin(req, res)) return;
            handleAdminFeedbackApproval(req, res);
            return;
        }

        if (req.method === 'POST' && requestedUrl.pathname === '/load-tournament-data') {
            if (!requireAdmin(req, res)) return;
            handleLoadTournamentData(res);
            return;
        }

        if (req.method === 'GET' && requestedUrl.pathname === '/load') {
            if (!requireAdmin(req, res)) return;
            handleLoad(req, res, config, requestedUrl);
            return;
        }

        if (req.method === 'GET' && requestedUrl.pathname === '/score-files') {
            if (!requireAdmin(req, res)) return;
            handleScoreFiles(res, config);
            return;
        }

        serveStaticFile(req, res);
    });
}

function startServer() {
    const config = readScoringPageConfig();
    ensureScoreFiles(config);
    ensureFeedbackFile();

    const server = createServer(config);
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 70000;
    server.timeout = 60000;
    server.listen(PORT, HOST, () => {
        console.log('');
        console.log('  Vertex Badminton Scoring Server');
        console.log('  =================================');
        console.log(`  Listening on:     http://${HOST}:${PORT}`);
        console.log('  Public access:    configure Apache as the public reverse proxy');
        console.log(`  Scores folder:   ${SCORES_DIR}`);
        console.log(`  Feedback file:   ${FEEDBACK_FILE}`);
        console.log(`  Event files:     ${config.events.length * config.divisions.length}`);
        console.log('  Press Ctrl+C to stop');
        console.log('');
    });

    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    readScoringPageConfig,
    ensureScoreFiles,
    getScoreFilePath,
    parseTournamentBracketPosters,
    createServer,
    startServer
};
