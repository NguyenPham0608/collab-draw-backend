const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Store drawing history
const MAX_HISTORY = 5000;
let drawHistory = [];

// Store connected users
const users = {};

console.log(`WebSocket server running on port ${PORT}`);

function broadcast(data, exclude = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastToAll(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    const odeli = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    let userId = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Handle user joining
            if (msg.type === 'join') {
                userId = odeli;
                users[userId] = {
                    username: msg.username || 'Anonymous',
                    color: msg.color || '#000000'
                };

                console.log(`User joined: ${users[userId].username} (${userId}). Total: ${Object.keys(users).length}`);

                // Send init data to new user
                ws.send(JSON.stringify({
                    type: 'init',
                    id: userId,
                    users: users
                }));

                // Send drawing history
                if (drawHistory.length > 0) {
                    ws.send(JSON.stringify({
                        type: 'history',
                        strokes: drawHistory
                    }));
                }

                // Broadcast new user to others
                broadcast({
                    type: 'userJoined',
                    id: userId,
                    username: users[userId].username,
                    color: users[userId].color
                }, ws);
            }

            // Handle drawing
            if (msg.type === 'draw' && userId) {
                drawHistory.push(msg.stroke);

                if (drawHistory.length > MAX_HISTORY) {
                    drawHistory = drawHistory.slice(-MAX_HISTORY);
                }

                broadcast({
                    type: 'draw',
                    stroke: msg.stroke
                }, ws);
            }

            // Handle color change
            if (msg.type === 'colorChange' && userId && users[userId]) {
                users[userId].color = msg.color;
                broadcast({
                    type: 'userColorChanged',
                    id: userId,
                    color: msg.color
                }, ws);
            }

            // Handle clear
            if (msg.type === 'clear') {
                drawHistory = [];
                broadcastToAll({ type: 'clear' });
            }

        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        if (userId && users[userId]) {
            console.log(`User left: ${users[userId].username} (${userId}). Total: ${Object.keys(users).length - 1}`);
            delete users[userId];
            broadcast({
                type: 'userLeft',
                id: userId
            });
        }
    });
});

// Keep connections alive
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

console.log('Server ready!');