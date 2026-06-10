# Vertex Badminton Scoring - Setup Guide

## Files

```
vertex_scoring/
├── server.js          ← Run this (Node.js server)
├── scoring_page.html  ← The scoring UI (served automatically)
├── scores.json        ← All submitted scores land here
└── SETUP_GUIDE.md     ← You are here
```

## How to Run

1. Open a terminal in this folder
2. Run:
   ```
   node server.js
   ```
3. Open **http://localhost:3000** in your browser
4. Enter scores → click **Save Scores**
5. Data is saved to `scores.json` in this folder

That's it. No installs, no dependencies, no Google account needed.

## How It Works

- `server.js` serves the HTML page AND handles POST requests
- When you click "Save Scores", the browser sends data to the server
- The server appends it to `scores.json` with a timestamp
- Each submission is one entry in the JSON array

## scores.json Structure

```json
[
  {
    "date": "2026-06-13",
    "event": "Men's Doubles",
    "division": "4-5",
    "pool": "A",
    "format": 4,
    "courts": "1, 2",
    "teams": [
      { "name": "Deepak / Dilesh", "totalGames": 3, "totalPoints": 78 },
      { "name": "Gokul / Surya", "totalGames": 3, "totalPoints": 81 }
    ],
    "scores": [
      { "team": 1, "opponent": 2, "set": 1, "games": 1, "points": 15 },
      { "team": 1, "opponent": 2, "set": 2, "games": 0, "points": 11 }
    ],
    "savedAt": "2026-06-13T10:30:00.000Z"
  }
]
```

## Tips

- Multiple devices can submit to the same server (use your PC's local IP instead of localhost)
- To find your IP: run `ipconfig` and look for IPv4 address, then use `http://192.168.x.x:3000`
- The server logs each save to the console
- To reset scores, just delete the contents of `scores.json` or replace with `[]`
