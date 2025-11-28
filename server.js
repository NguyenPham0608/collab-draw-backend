const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Store drawing history (limited to prevent memory issues)
const MAX_HISTORY = 5000;
let drawHistory = [];

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', (ws) => {
    console.log('New client connected. Total:', wss.clients.size);

    // Send existing drawing history to new client
    if (drawHistory.length > 0) {
        ws.send(JSON.stringify({
            type: 'history',
            strokes: drawHistory
        }));
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'draw') {
                // Store stroke in history
                drawHistory.push(msg.stroke);

                // Trim history if too large
                if (drawHistory.length > MAX_HISTORY) {
                    drawHistory = drawHistory.slice(-MAX_HISTORY);
                }

                // Broadcast to all OTHER clients
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'draw',
                            stroke: msg.stroke
                        }));
                    }
                });
            }

            if (msg.type === 'clear') {
                drawHistory = [];
                // Broadcast clear to everyone
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'clear' }));
                    }
                });
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected. Total:', wss.clients.size);
    });
});

// Keep connections alive with ping/pong
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});