/**
 * Vertex Scoring - Local Server
 * 
 * Saves scores to scores.json in the same folder.
 * 
 * USAGE:
 *   1. Install Node.js if you don't have it (https://nodejs.org)
 *   2. Open terminal in this folder
 *   3. Run: node server.js
 *   4. Open http://localhost:3000 in your browser
 *   5. Enter scores and click Submit — data saves to scores.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const SCORES_FILE = path.join(__dirname, 'scores.json');

// Ensure scores.json exists
if (!fs.existsSync(SCORES_FILE)) {
    fs.writeFileSync(SCORES_FILE, JSON.stringify([], null, 2));
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // POST /save — save scores to JSON file
    if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const newEntry = JSON.parse(body);
                newEntry.savedAt = new Date().toISOString();

                // Read existing data
                let existing = [];
                try {
                    const raw = fs.readFileSync(SCORES_FILE, 'utf8');
                    existing = JSON.parse(raw);
                    if (!Array.isArray(existing)) existing = [];
                } catch (e) {
                    existing = [];
                }

                // Append new entry
                existing.push(newEntry);

                // Write back
                fs.writeFileSync(SCORES_FILE, JSON.stringify(existing, null, 2));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success', message: 'Saved to scores.json', totalEntries: existing.length }));
                
                console.log(`[${new Date().toLocaleTimeString()}] ✅ Scores saved — ${existing.length} total entries`);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: err.message }));
                console.error(`[${new Date().toLocaleTimeString()}] ❌ Error:`, err.message);
            }
        });
        return;
    }

    // GET /scores — read current scores
    if (req.method === 'GET' && req.url === '/scores') {
        try {
            const raw = fs.readFileSync(SCORES_FILE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(raw);
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
        }
        return;
    }

    // Serve static files (HTML, CSS, JS)
    let filePath = req.url === '/' ? '/scoring_page.html' : req.url;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found: ' + req.url);
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log('');
    console.log('  🏸 Vertex Badminton Scoring Server');
    console.log('  ══════════════════════════════════════');
    console.log(`  🌐 Open in browser: http://localhost:${PORT}`);
    console.log(`  💾 Scores save to:  ${SCORES_FILE}`);
    console.log('  ⏹️  Press Ctrl+C to stop');
    console.log('');
});
