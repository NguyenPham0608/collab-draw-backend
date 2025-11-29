const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============================================
// GAME CONFIGURATION
// ============================================
const NUM_ROOMS = 5;
const PLAYERS_PER_TEAM = 2;
const ROUND_DURATION = 120;
const FORTRESS_TIME = 15;
const COUNTDOWN_TIME = 5;
const POINTS_TO_WIN = 3;
const MAX_INK = 100;
const INK_REGEN_RATE = 8;
const INK_COST_PER_PIXEL = 0.12;
const CRYSTAL_RADIUS = 40;
const CRYSTAL_X = 80;
const CRYSTAL_Y = 350;
const COLLISION_THRESHOLD = 20; // Distance threshold for collision

// ============================================
// ROOM & GAME STATE
// ============================================

const rooms = {};
for (let i = 1; i <= NUM_ROOMS; i++) {
    rooms[i] = {
        id: i,
        players: {},
        redTeam: [],
        blueTeam: [],
        strokes: [],
        gameState: 'waiting',
        scores: { red: 0, blue: 0 },
        currentRound: 0,
        attackingTeam: 'red',
        timer: null,
        timeRemaining: ROUND_DURATION,
        fortressTimer: null,
        countdownTimer: null,
        inkRegenTimer: null,
        strokeIdCounter: 0
    };
}

const playerData = new Map();

console.log(`⚔️  Siege Server running on port ${PORT}`);
console.log(`📍 ${NUM_ROOMS} rooms available`);

// ============================================
// COLLISION DETECTION - PROPER LINE SEGMENT
// ============================================

// Calculate minimum distance between two line segments
function lineSegmentDistance(x1, y1, x2, y2, x3, y3, x4, y4) {
    // Check if segments intersect
    if (segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4)) {
        return 0;
    }

    // Otherwise find minimum distance between endpoints and segments
    const d1 = pointToSegmentDistance(x1, y1, x3, y3, x4, y4);
    const d2 = pointToSegmentDistance(x2, y2, x3, y3, x4, y4);
    const d3 = pointToSegmentDistance(x3, y3, x1, y1, x2, y2);
    const d4 = pointToSegmentDistance(x4, y4, x1, y1, x2, y2);

    return Math.min(d1, d2, d3, d4);
}

// Check if two line segments intersect
function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d1 = direction(x3, y3, x4, y4, x1, y1);
    const d2 = direction(x3, y3, x4, y4, x2, y2);
    const d3 = direction(x1, y1, x2, y2, x3, y3);
    const d4 = direction(x1, y1, x2, y2, x4, y4);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }

    if (d1 === 0 && onSegment(x3, y3, x4, y4, x1, y1)) return true;
    if (d2 === 0 && onSegment(x3, y3, x4, y4, x2, y2)) return true;
    if (d3 === 0 && onSegment(x1, y1, x2, y2, x3, y3)) return true;
    if (d4 === 0 && onSegment(x1, y1, x2, y2, x4, y4)) return true;

    return false;
}

function direction(xi, yi, xj, yj, xk, yk) {
    return (xk - xi) * (yj - yi) - (xj - xi) * (yk - yi);
}

function onSegment(xi, yi, xj, yj, xk, yk) {
    return Math.min(xi, xj) <= xk && xk <= Math.max(xi, xj) &&
        Math.min(yi, yj) <= yk && yk <= Math.max(yi, yj);
}

// Distance from point to line segment
function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;

    return Math.sqrt((px - nearestX) * (px - nearestX) + (py - nearestY) * (py - nearestY));
}

// Check collision between new stroke and all enemy strokes
function checkStrokeCollisions(roomId, newStroke, newStrokeTeam) {
    const room = rooms[roomId];
    const collidedIds = [];

    const threshold = COLLISION_THRESHOLD + (newStroke.size / 2);

    room.strokes.forEach((existingStroke) => {
        // Only check collision between different teams
        if (existingStroke.team === newStrokeTeam) return;

        const combinedThreshold = threshold + (existingStroke.size / 2);

        const dist = lineSegmentDistance(
            newStroke.x1, newStroke.y1, newStroke.x2, newStroke.y2,
            existingStroke.x1, existingStroke.y1, existingStroke.x2, existingStroke.y2
        );

        if (dist < combinedThreshold) {
            collidedIds.push(existingStroke.id);
        }
    });

    return collidedIds;
}

function checkCrystalCollision(stroke) {
    const dx = stroke.x2 - stroke.x1;
    const dy = stroke.y2 - stroke.y1;

    // Check distance from crystal center to line segment
    const dist = pointToSegmentDistance(CRYSTAL_X, CRYSTAL_Y, stroke.x1, stroke.y1, stroke.x2, stroke.y2);

    return dist < (CRYSTAL_RADIUS + stroke.size / 2);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function broadcast(roomId, data, exclude = null) {
    const message = JSON.stringify(data);
    const room = rooms[roomId];

    if (!room) return;

    Object.values(room.players).forEach(player => {
        if (player.ws !== exclude && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

function broadcastToAll(roomId, data) {
    const message = JSON.stringify(data);
    const room = rooms[roomId];

    if (!room) return;

    Object.values(room.players).forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

function getPublicPlayerList(roomId) {
    const room = rooms[roomId];
    if (!room) return {};

    const players = {};

    Object.entries(room.players).forEach(([id, player]) => {
        players[id] = {
            username: player.username,
            team: player.team,
            ink: player.ink
        };
    });

    return players;
}

function getRoomSummaries() {
    const summaries = {};

    for (let i = 1; i <= NUM_ROOMS; i++) {
        const room = rooms[i];
        summaries[i] = {
            id: i,
            playerCount: Object.keys(room.players).length,
            redCount: room.redTeam.length,
            blueCount: room.blueTeam.length,
            gameState: room.gameState,
            scores: room.scores
        };
    }

    return summaries;
}

function assignTeam(roomId) {
    const room = rooms[roomId];

    if (room.redTeam.length <= room.blueTeam.length) {
        return 'red';
    } else {
        return 'blue';
    }
}

function canJoinRoom(roomId) {
    const room = rooms[roomId];
    const totalPlayers = Object.keys(room.players).length;
    return totalPlayers < PLAYERS_PER_TEAM * 2;
}

function checkGameStart(roomId) {
    const room = rooms[roomId];

    if (room.redTeam.length >= PLAYERS_PER_TEAM &&
        room.blueTeam.length >= PLAYERS_PER_TEAM &&
        room.gameState === 'waiting') {
        startCountdown(roomId);
    }
}

function clearAllTimers(roomId) {
    const room = rooms[roomId];
    if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
    }
    if (room.fortressTimer) {
        clearInterval(room.fortressTimer);
        room.fortressTimer = null;
    }
    if (room.countdownTimer) {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
    }
    if (room.inkRegenTimer) {
        clearInterval(room.inkRegenTimer);
        room.inkRegenTimer = null;
    }
}

function startInkRegeneration(roomId) {
    const room = rooms[roomId];

    if (room.inkRegenTimer) {
        clearInterval(room.inkRegenTimer);
    }

    room.inkRegenTimer = setInterval(() => {
        let inkChanged = false;

        Object.values(room.players).forEach(player => {
            if (player.ink < MAX_INK) {
                player.ink = Math.min(MAX_INK, player.ink + INK_REGEN_RATE);
                inkChanged = true;
            }
        });

        if (inkChanged) {
            broadcastToAll(roomId, {
                type: 'inkUpdate',
                players: getPublicPlayerList(roomId)
            });
        }
    }, 1000);
}

function startCountdown(roomId) {
    const room = rooms[roomId];
    room.gameState = 'countdown';
    room.timeRemaining = COUNTDOWN_TIME;

    console.log(`⏱️  Room ${roomId}: Starting countdown...`);

    broadcastToAll(roomId, {
        type: 'phaseChange',
        phase: 'countdown',
        timeRemaining: COUNTDOWN_TIME
    });

    room.countdownTimer = setInterval(() => {
        room.timeRemaining--;

        broadcastToAll(roomId, {
            type: 'countdown',
            timeRemaining: room.timeRemaining
        });

        if (room.timeRemaining <= 0) {
            clearInterval(room.countdownTimer);
            room.countdownTimer = null;
            startFortressPhase(roomId);
        }
    }, 1000);
}

function startFortressPhase(roomId) {
    const room = rooms[roomId];
    room.gameState = 'fortress';
    room.currentRound++;
    room.timeRemaining = FORTRESS_TIME;

    Object.values(room.players).forEach(player => {
        player.ink = MAX_INK;
    });

    console.log(`🏰 Room ${roomId}: Fortress phase started (Round ${room.currentRound})`);

    broadcastToAll(roomId, {
        type: 'phaseChange',
        phase: 'fortress',
        attackingTeam: room.attackingTeam,
        timeRemaining: FORTRESS_TIME,
        round: room.currentRound,
        players: getPublicPlayerList(roomId)
    });

    startInkRegeneration(roomId);

    room.fortressTimer = setInterval(() => {
        room.timeRemaining--;

        broadcastToAll(roomId, {
            type: 'timerUpdate',
            timeRemaining: room.timeRemaining,
            phase: 'fortress'
        });

        if (room.timeRemaining <= 0) {
            clearInterval(room.fortressTimer);
            room.fortressTimer = null;
            startPlayingPhase(roomId);
        }
    }, 1000);
}

function startPlayingPhase(roomId) {
    const room = rooms[roomId];
    room.gameState = 'playing';
    room.timeRemaining = ROUND_DURATION;

    console.log(`⚔️  Room ${roomId}: Battle phase started!`);

    broadcastToAll(roomId, {
        type: 'phaseChange',
        phase: 'playing',
        attackingTeam: room.attackingTeam,
        timeRemaining: ROUND_DURATION,
        players: getPublicPlayerList(roomId)
    });

    room.timer = setInterval(() => {
        room.timeRemaining--;

        broadcastToAll(roomId, {
            type: 'timerUpdate',
            timeRemaining: room.timeRemaining,
            phase: 'playing'
        });

        if (room.timeRemaining <= 0) {
            endRound(roomId, room.attackingTeam === 'red' ? 'blue' : 'red');
        }
    }, 1000);
}

function endRound(roomId, winner) {
    const room = rooms[roomId];

    clearAllTimers(roomId);

    room.gameState = 'roundEnd';
    room.scores[winner]++;

    console.log(`🏆 Room ${roomId}: ${winner.toUpperCase()} wins! Score: Red ${room.scores.red} - Blue ${room.scores.blue}`);

    broadcastToAll(roomId, {
        type: 'roundEnd',
        winner: winner,
        scores: room.scores
    });

    if (room.scores.red >= POINTS_TO_WIN || room.scores.blue >= POINTS_TO_WIN) {
        gameOver(roomId, room.scores.red >= POINTS_TO_WIN ? 'red' : 'blue');
        return;
    }

    room.attackingTeam = room.attackingTeam === 'red' ? 'blue' : 'red';
    room.strokes = [];
    room.strokeIdCounter = 0;

    Object.values(room.players).forEach(player => {
        player.ink = MAX_INK;
    });

    setTimeout(() => {
        if (room.redTeam.length >= PLAYERS_PER_TEAM && room.blueTeam.length >= PLAYERS_PER_TEAM) {
            startFortressPhase(roomId);
        } else {
            resetRoom(roomId);
        }
    }, 3000);
}

function gameOver(roomId, winner) {
    const room = rooms[roomId];
    room.gameState = 'gameOver';

    clearAllTimers(roomId);

    console.log(`👑 Room ${roomId}: GAME OVER! ${winner.toUpperCase()} WINS!`);

    broadcastToAll(roomId, {
        type: 'gameOver',
        winner: winner,
        scores: room.scores
    });

    setTimeout(() => {
        resetRoom(roomId);
    }, 5000);
}

function resetRoom(roomId) {
    const room = rooms[roomId];

    clearAllTimers(roomId);

    room.strokes = [];
    room.strokeIdCounter = 0;
    room.gameState = 'waiting';
    room.scores = { red: 0, blue: 0 };
    room.currentRound = 0;
    room.attackingTeam = 'red';
    room.timeRemaining = ROUND_DURATION;

    Object.values(room.players).forEach(player => {
        player.ink = MAX_INK;
    });

    broadcastToAll(roomId, {
        type: 'roomReset',
        players: getPublicPlayerList(roomId)
    });

    checkGameStart(roomId);
}

// ============================================
// WEBSOCKET HANDLING
// ============================================

wss.on('connection', (ws) => {
    const odeli = Date.now().toString() + Math.random().toString(36).substr(2, 9);

    ws.send(JSON.stringify({
        type: 'roomList',
        rooms: getRoomSummaries()
    }));

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const player = playerData.get(ws);

            if (msg.type === 'getRooms') {
                ws.send(JSON.stringify({
                    type: 'roomList',
                    rooms: getRoomSummaries()
                }));
            }

            if (msg.type === 'joinRoom') {
                const roomId = msg.roomId;

                if (!rooms[roomId]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid room' }));
                    return;
                }

                if (!canJoinRoom(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
                    return;
                }

                const team = assignTeam(roomId);
                const room = rooms[roomId];

                const newPlayer = {
                    id: odeli,
                    username: msg.username || 'Anonymous',
                    team: team,
                    ink: MAX_INK,
                    ws: ws
                };

                room.players[odeli] = newPlayer;

                if (team === 'red') {
                    room.redTeam.push(odeli);
                } else {
                    room.blueTeam.push(odeli);
                }

                playerData.set(ws, { odeli, roomId });

                console.log(`👤 ${newPlayer.username} joined Room ${roomId} on ${team.toUpperCase()} (${room.redTeam.length}v${room.blueTeam.length})`);

                ws.send(JSON.stringify({
                    type: 'joinedRoom',
                    id: odeli,
                    roomId: roomId,
                    team: team,
                    players: getPublicPlayerList(roomId),
                    gameState: room.gameState,
                    scores: room.scores,
                    attackingTeam: room.attackingTeam,
                    timeRemaining: room.timeRemaining,
                    round: room.currentRound,
                    strokes: room.strokes,
                    crystal: { x: CRYSTAL_X, y: CRYSTAL_Y, radius: CRYSTAL_RADIUS }
                }));

                broadcast(roomId, {
                    type: 'playerJoined',
                    id: odeli,
                    username: newPlayer.username,
                    team: team,
                    ink: MAX_INK
                }, ws);

                checkGameStart(roomId);
            }

            // Handle drawing - SERVER AUTHORITATIVE MODEL
            if (msg.type === 'draw' && player) {
                const roomId = player.roomId;
                const room = rooms[roomId];

                if (!room) return;

                const playerObj = room.players[player.odeli];

                if (!playerObj) return;

                const isDefender = (room.attackingTeam === 'red' && playerObj.team === 'blue') ||
                    (room.attackingTeam === 'blue' && playerObj.team === 'red');

                if (room.gameState === 'fortress' && !isDefender) {
                    return;
                }

                if (room.gameState !== 'fortress' && room.gameState !== 'playing') {
                    return;
                }

                const dx = msg.stroke.x2 - msg.stroke.x1;
                const dy = msg.stroke.y2 - msg.stroke.y1;
                const strokeLength = Math.sqrt(dx * dx + dy * dy);
                const inkCost = strokeLength * INK_COST_PER_PIXEL * (msg.stroke.size / 10);

                if (playerObj.ink < inkCost) {
                    ws.send(JSON.stringify({ type: 'noInk' }));
                    return;
                }

                playerObj.ink -= inkCost;

                // Create stroke with unique ID
                const stroke = {
                    id: room.strokeIdCounter++,
                    x1: msg.stroke.x1,
                    y1: msg.stroke.y1,
                    x2: msg.stroke.x2,
                    y2: msg.stroke.y2,
                    color: playerObj.team === 'red' ? '#ff2d55' : '#00d4ff',
                    size: msg.stroke.size,
                    team: playerObj.team,
                    playerId: player.odeli
                };

                // Check for collisions with enemy strokes
                const collidedIds = checkStrokeCollisions(roomId, stroke, playerObj.team);

                if (collidedIds.length > 0) {
                    // Remove collided strokes from room
                    room.strokes = room.strokes.filter(s => !collidedIds.includes(s.id));

                    // Broadcast collision to ALL players - new stroke is also destroyed
                    broadcastToAll(roomId, {
                        type: 'collision',
                        removedIds: collidedIds,
                        newStroke: stroke, // Send it so clients can animate it
                        destroyed: true    // But mark it as destroyed
                    });
                } else {
                    // No collision - add stroke and broadcast to ALL (including sender)
                    room.strokes.push(stroke);

                    // Check crystal collision (only attackers during playing phase)
                    const isAttacker = !isDefender;
                    if (room.gameState === 'playing' && isAttacker) {
                        if (checkCrystalCollision(stroke)) {
                            // Broadcast the winning stroke first
                            broadcastToAll(roomId, {
                                type: 'draw',
                                stroke: stroke
                            });
                            // Then end the round
                            endRound(roomId, room.attackingTeam);
                            return;
                        }
                    }

                    // Broadcast stroke to ALL clients (server authoritative)
                    broadcastToAll(roomId, {
                        type: 'draw',
                        stroke: stroke
                    });
                }

                // Send ink update to the drawing player
                ws.send(JSON.stringify({
                    type: 'inkUpdate',
                    ink: playerObj.ink
                }));
            }

        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        const player = playerData.get(ws);

        if (player) {
            const { odeli, roomId } = player;
            const room = rooms[roomId];

            if (room && room.players[odeli]) {
                const team = room.players[odeli].team;
                const username = room.players[odeli].username;

                if (team === 'red') {
                    room.redTeam = room.redTeam.filter(id => id !== odeli);
                } else {
                    room.blueTeam = room.blueTeam.filter(id => id !== odeli);
                }

                delete room.players[odeli];

                console.log(`👋 ${username} left Room ${roomId} (${room.redTeam.length}v${room.blueTeam.length})`);

                broadcast(roomId, {
                    type: 'playerLeft',
                    id: odeli
                });

                if (room.gameState === 'countdown') {
                    if (room.redTeam.length < PLAYERS_PER_TEAM || room.blueTeam.length < PLAYERS_PER_TEAM) {
                        clearAllTimers(roomId);
                        room.gameState = 'waiting';
                        broadcastToAll(roomId, {
                            type: 'countdownCancelled',
                            reason: 'Not enough players'
                        });
                    }
                }

                if (room.gameState === 'playing' || room.gameState === 'fortress') {
                    if (room.redTeam.length === 0 || room.blueTeam.length === 0) {
                        const winner = room.redTeam.length === 0 ? 'blue' : 'red';
                        endRound(roomId, winner);
                    }
                }
            }

            playerData.delete(ws);
        }
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

setInterval(() => {
    const summaries = getRoomSummaries();
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'roomList',
                rooms: summaries
            }));
        }
    });
}, 5000);

console.log('⚔️  Siege Server ready!');