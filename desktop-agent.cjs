'use strict';

// WorkMonitor local Windows input counter. Counts event totals only; it never
// stores key codes, key names, typed text, window titles, or screenshots.
// Runs on loopback only and accepts requests from local WorkMonitor dev/prod pages.
const http = require('node:http');
const { uIOhook } = require('uiohook-napi');

const HOST = '127.0.0.1';
const PORT = 3210;
let tracking = false;
let paused = false;
let counts = { mouseMoves: 0, mouseClicks: 0, keyPresses: 0 };
let lastMouse = null;
let activeSeconds = 0;
let trackedSeconds = 0;
let lastInputAt = 0;

const ACTIVITY_TIMEOUT_MS = 1000;

setInterval(() => {
  if (!tracking || paused) return;

  trackedSeconds += 1;

  if (
    lastInputAt > 0 &&
    Date.now() - lastInputAt <= ACTIVITY_TIMEOUT_MS
  ) {
    activeSeconds += 1;
  }
}, 1000);

function resetActivityTime() {
  activeSeconds = 0;
  trackedSeconds = 0;
  lastInputAt = 0;
}

// uIOhook.on('mousemove', (event) => {
//   if (!tracking || paused) return;
//   const current = { x: event.x, y: event.y };
//   if (lastMouse && Math.hypot(current.x - lastMouse.x, current.y - lastMouse.y) >= 2) {
//     counts.mouseMoves += 1;
//   }
//   lastMouse = current;
// });
uIOhook.on('mousemove', (event) => {
  if (!tracking || paused) return;

  const current = { x: event.x, y: event.y };

  if (
    lastMouse &&
    Math.hypot(
      current.x - lastMouse.x,
      current.y - lastMouse.y
    ) >= 2
  ) {
    counts.mouseMoves += 1;
    lastInputAt = Date.now();
  }

  lastMouse = current;
});
// uIOhook.on('mousedown', () => {
//   if (tracking && !paused) counts.mouseClicks += 1;
// });
uIOhook.on('mousedown', () => {
  if (!tracking || paused) return;

  counts.mouseClicks += 1;
  lastInputAt = Date.now();
});
// uIOhook.on('keydown', () => {
//   // Intentionally ignore the event payload so no typed content is captured.
//   if (tracking && !paused) counts.keyPresses += 1;
// });
uIOhook.on('keydown', () => {
  // Intentionally ignore the event payload so no typed content is captured.
  if (!tracking || paused) return;

  counts.keyPresses += 1;
  lastInputAt = Date.now();
});



function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    const action = (req.url || '').replace(/^\//, '');
    // if (action === 'start') {
    //   counts = { mouseMoves: 0, mouseClicks: 0, keyPresses: 0 };
    //   lastMouse = null;
    //   tracking = true; paused = false;
    //   return send(res, 200, { success: true, tracking, paused });
      
    // }
    if (action === 'start') {
      counts = { mouseMoves: 0, mouseClicks: 0, keyPresses: 0 };
      lastMouse = null;
      resetActivityTime();
      tracking = true;
      paused = false;
      return send(res, 200, { success: true, tracking, paused });
    }
    // if (action === 'pause') { paused = true; return send(res, 200, { success: true }); }
    // if (action === 'resume') { if (tracking) paused = false; return send(res, 200, { success: true }); }
    
if (action === 'pause') {
  paused = true;
  lastInputAt = 0;

  return send(res, 200, { success: true });
}

if (action === 'resume') {
  if (tracking) {
    lastInputAt = 0;
    paused = false;
  }

  return send(res, 200, { success: true });
}

    // if (action === 'stop') { tracking = false; paused = false; lastMouse = null; return send(res, 200, { success: true }); }
    
if (action === 'stop') {
  tracking = false;
  paused = false;
  lastMouse = null;
  resetActivityTime();

  return send(res, 200, { success: true });
}

    // if (action === 'snapshot') {
    //   const snapshot = { ...counts };
    //   counts = { mouseMoves: 0, mouseClicks: 0, keyPresses: 0 };
    //   lastMouse = null;
    //   return send(res, 200, { success: true, counts: snapshot });
    // }
    
if (action === 'snapshot') {
  const snapshot = {
    ...counts,
    activeSeconds,
    trackedSeconds,
    activityPercent:
      trackedSeconds > 0
        ? Math.min(
            100,
            Math.round((activeSeconds / trackedSeconds) * 100)
          )
        : 0,
  };

  counts = { mouseMoves: 0, mouseClicks: 0, keyPresses: 0 };
  resetActivityTime();
  lastMouse = null;

  return send(res, 200, { success: true, counts: snapshot });
}

    return send(res, 404, { error: 'Unknown action' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WorkMonitor activity agent listening on http://${HOST}:${PORT}`);
  console.log('Global event counts are active only during Start Tracking; no key content is recorded.');
  try { uIOhook.start(); } catch (error) { console.error('Could not start global input hook:', error); process.exitCode = 1; }
});

function shutdown() {
  tracking = false;
  try { uIOhook.stop(); } catch {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
