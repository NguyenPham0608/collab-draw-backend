const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============================================
// GAME CONFIGURATION
// ============================================
const NUM_ROOMS = 5;
const PLAYERS_PER_TEAM = 2;
const ROUND_DURATION = 120; // seconds
const FORTRESS_TIME = 15; // seconds head start for defenders
const COUNTDOWN_TIME = 5; // seconds before game starts
const POINTS_TO_WIN = 3;
const MAX_INK = 100;
const INK_REGEN_RATE = 8; // per second (increased for better gameplay)
const INK_COST_PER_PIXEL = 0.12;
const CRYSTAL_RADIUS = 40;
const CRYSTAL_X = 80;
const CRYSTAL_Y = 350; // center of 700px height
const COLLISION_RADIUS = 15;

// ============================================
// ROOM & GAME STATE
// ============================================

// Initialize 5 rooms
const rooms = {};
for (let i = 1; i <= NUM_ROOMS; i++) {
    rooms[i] = {
        id: i,
        players: {},
        redTeam: [],
        blueTeam: [],
        strokes: [],
        gameState: 'waiting', // waiting, countdown, fortress, playing, roundEnd, gameOver
        scores: { red: 0, blue: 0 },
        currentRound: 0,
        attackingTeam: 'red', // red attacks first, then swap
        timer: null,
        timeRemaining: ROUND_DURATION,
        fortressTimer: null,
        countdownTimer: null,
        inkRegenTimer: null
    };
}

// Player connections mapped to their data
const playerData = new Map();

console.log(`⚔️  Siege Server running on port ${PORT}`);
console.log(`📍 ${NUM_ROOMS} rooms available`);

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
    broadcast(roomId, data, null);
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

    // Assign to team with fewer players, prefer red if equal
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

    // Need exactly 2v2 to start
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

    // Clear existing ink regen timer
    if (room.inkRegenTimer) {
        clearInterval(room.inkRegenTimer);
    }

    // Regenerate ink every second for all players
    room.inkRegenTimer = setInterval(() => {
        let inkChanged = false;

        Object.values(room.players).forEach(player => {
            if (player.ink < MAX_INK) {
                player.ink = Math.min(MAX_INK, player.ink + INK_REGEN_RATE);
                inkChanged = true;
            }
        });

        // Broadcast ink updates if any changed
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

    // Countdown timer
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

    // Reset ink for all players at round start
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

    // Start ink regeneration
    startInkRegeneration(roomId);

    // Fortress countdown
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

    // Game countdown (ink regen is already running)
    room.timer = setInterval(() => {
        room.timeRemaining--;

        broadcastToAll(roomId, {
            type: 'timerUpdate',
            timeRemaining: room.timeRemaining,
            phase: 'playing'
        });

        if (room.timeRemaining <= 0) {
            // Defenders win!
            endRound(roomId, room.attackingTeam === 'red' ? 'blue' : 'red');
        }
    }, 1000);
}

function endRound(roomId, winner) {
    const room = rooms[roomId];

    clearAllTimers(roomId);

    room.gameState = 'roundEnd';
    room.scores[winner]++;

    console.log(`🏆 Room ${roomId}: ${winner.toUpperCase()} wins the round! Score: Red ${room.scores.red} - Blue ${room.scores.blue}`);

    broadcastToAll(roomId, {
        type: 'roundEnd',
        winner: winner,
        scores: room.scores
    });

    // Check for game over
    if (room.scores.red >= POINTS_TO_WIN || room.scores.blue >= POINTS_TO_WIN) {
        gameOver(roomId, room.scores.red >= POINTS_TO_WIN ? 'red' : 'blue');
        return;
    }

    // Swap attacking team for next round
    room.attackingTeam = room.attackingTeam === 'red' ? 'blue' : 'red';

    // Clear strokes for new round
    room.strokes = [];

    // Reset ink for all players
    Object.values(room.players).forEach(player => {
        player.ink = MAX_INK;
    });

    // Start next round after delay
    setTimeout(() => {
        // Check we still have enough players
        if (room.redTeam.length >= PLAYERS_PER_TEAM && room.blueTeam.length >= PLAYERS_PER_TEAM) {
            startFortressPhase(roomId);
        } else {
            // Not enough players, reset room
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

    // Reset room after delay
    setTimeout(() => {
        resetRoom(roomId);
    }, 5000);
}

function resetRoom(roomId) {
    const room = rooms[roomId];

    clearAllTimers(roomId);

    room.strokes = [];
    room.gameState = 'waiting';
    room.scores = { red: 0, blue: 0 };
    room.currentRound = 0;
    room.attackingTeam = 'red';
    room.timeRemaining = ROUND_DURATION;

    // Reset player ink
    Object.values(room.players).forEach(player => {
        player.ink = MAX_INK;
    });

    broadcastToAll(roomId, {
        type: 'roomReset',
        players: getPublicPlayerList(roomId)
    });

    // Check if we can start a new game
    checkGameStart(roomId);
}

function checkCrystalCollision(stroke, attackingTeam) {
    // Check if the stroke touches the crystal
    const dx = stroke.x2 - stroke.x1;
    const dy = stroke.y2 - stroke.y1;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len === 0) {
        const dist = Math.sqrt(Math.pow(stroke.x1 - CRYSTAL_X, 2) + Math.pow(stroke.y1 - CRYSTAL_Y, 2));
        return dist < CRYSTAL_RADIUS + stroke.size / 2;
    }

    // Check multiple points along the stroke
    for (let t = 0; t <= 1; t += 0.1) {
        const px = stroke.x1 + dx * t;
        const py = stroke.y1 + dy * t;
        const dist = Math.sqrt(Math.pow(px - CRYSTAL_X, 2) + Math.pow(py - CRYSTAL_Y, 2));

        if (dist < CRYSTAL_RADIUS + stroke.size / 2) {
            return true;
        }
    }

    return false;
}

function checkStrokeCollisions(roomId, newStroke, newStrokeTeam) {
    const room = rooms[roomId];
    const collidedIndices = [];

    room.strokes.forEach((existingStroke, index) => {
        // Only check collision between different teams
        if (existingStroke.team === newStrokeTeam) return;

        // Simple proximity check for collision
        const minDist = COLLISION_RADIUS + (existingStroke.size + newStroke.size) / 2;

        // Check endpoints and midpoints
        const points1 = [
            { x: newStroke.x1, y: newStroke.y1 },
            { x: newStroke.x2, y: newStroke.y2 },
            { x: (newStroke.x1 + newStroke.x2) / 2, y: (newStroke.y1 + newStroke.y2) / 2 }
        ];

        const points2 = [
            { x: existingStroke.x1, y: existingStroke.y1 },
            { x: existingStroke.x2, y: existingStroke.y2 },
            { x: (existingStroke.x1 + existingStroke.x2) / 2, y: (existingStroke.y1 + existingStroke.y2) / 2 }
        ];

        for (const p1 of points1) {
            for (const p2 of points2) {
                const dist = Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
                if (dist < minDist) {
                    collidedIndices.push(index);
                    return;
                }
            }
        }
    });

    return collidedIndices;
}

// ============================================
// WEBSOCKET HANDLING
// ============================================

wss.on('connection', (ws) => {
    const odeli = Date.now().toString() + Math.random().toString(36).substr(2, 9);

    // Send room list on connect
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

            // Request room list
            if (msg.type === 'getRooms') {
                ws.send(JSON.stringify({
                    type: 'roomList',
                    rooms: getRoomSummaries()
                }));
            }

            // Join a room
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

                console.log(`👤 ${newPlayer.username} joined Room ${roomId} on ${team.toUpperCase()} team (${room.redTeam.length}v${room.blueTeam.length})`);

                // Send init to player
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

                // Broadcast to others
                broadcast(roomId, {
                    type: 'playerJoined',
                    id: odeli,
                    username: newPlayer.username,
                    team: team,
                    ink: MAX_INK
                }, ws);

                // Check if game can start (need 2v2)
                checkGameStart(roomId);
            }

            // Handle drawing
            if (msg.type === 'draw' && player) {
                const roomId = player.roomId;
                const room = rooms[roomId];

                if (!room) return;

                const playerObj = room.players[player.odeli];

                if (!playerObj) return;

                // Check game state - only allow drawing in fortress (defenders only) or playing
                const isDefender = (room.attackingTeam === 'red' && playerObj.team === 'blue') ||
                    (room.attackingTeam === 'blue' && playerObj.team === 'red');

                if (room.gameState === 'fortress' && !isDefender) {
                    return; // Attackers can't draw during fortress phase
                }

                if (room.gameState !== 'fortress' && room.gameState !== 'playing') {
                    return;
                }

                // Calculate ink cost
                const dx = msg.stroke.x2 - msg.stroke.x1;
                const dy = msg.stroke.y2 - msg.stroke.y1;
                const strokeLength = Math.sqrt(dx * dx + dy * dy);
                const inkCost = strokeLength * INK_COST_PER_PIXEL * (msg.stroke.size / 10);

                if (playerObj.ink < inkCost) {
                    ws.send(JSON.stringify({ type: 'noInk' }));
                    return;
                }

                // Deduct ink
                playerObj.ink -= inkCost;

                // Add team info to stroke
                const stroke = {
                    ...msg.stroke,
                    team: playerObj.team,
                    playerId: player.odeli
                };

                // Check for collisions with enemy strokes
                const collisions = checkStrokeCollisions(roomId, stroke, playerObj.team);

                if (collisions.length > 0) {
                    // Remove collided strokes
                    const removedStrokes = collisions.map(i => room.strokes[i]);
                    room.strokes = room.strokes.filter((_, i) => !collisions.includes(i));

                    // Broadcast collision
                    broadcastToAll(roomId, {
                        type: 'collision',
                        removedStrokes: removedStrokes,
                        newStroke: stroke
                    });
                } else {
                    // Add stroke to history
                    room.strokes.push(stroke);

                    // Check crystal collision (only during playing phase, only attackers)
                    const isAttacker = !isDefender;
                    if (room.gameState === 'playing' && isAttacker) {
                        if (checkCrystalCollision(stroke, room.attackingTeam)) {
                            // Attackers win!
                            endRound(roomId, room.attackingTeam);
                            return;
                        }
                    }

                    // Broadcast stroke
                    broadcast(roomId, {
                        type: 'draw',
                        stroke: stroke
                    }, ws);
                }

                // Send ink update to player
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

                // Remove from team
                if (team === 'red') {
                    room.redTeam = room.redTeam.filter(id => id !== odeli);
                } else {
                    room.blueTeam = room.blueTeam.filter(id => id !== odeli);
                }

                // Remove from players
                delete room.players[odeli];

                console.log(`👋 ${username} left Room ${roomId} (${room.redTeam.length}v${room.blueTeam.length})`);

                // Broadcast departure
                broadcast(roomId, {
                    type: 'playerLeft',
                    id: odeli
                });

                // Handle player leaving during countdown
                if (room.gameState === 'countdown') {
                    // Cancel countdown if not enough players
                    if (room.redTeam.length < PLAYERS_PER_TEAM || room.blueTeam.length < PLAYERS_PER_TEAM) {
                        clearAllTimers(roomId);
                        room.gameState = 'waiting';
                        broadcastToAll(roomId, {
                            type: 'countdownCancelled',
                            reason: 'Not enough players'
                        });
                    }
                }

                // Check if game should end during active play
                if (room.gameState === 'playing' || room.gameState === 'fortress') {
                    if (room.redTeam.length === 0 || room.blueTeam.length === 0) {
                        // End game if a team is empty
                        const winner = room.redTeam.length === 0 ? 'blue' : 'red';
                        endRound(roomId, winner);
                    }
                }
            }

            playerData.delete(ws);
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

// Broadcast room updates every 5 seconds
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