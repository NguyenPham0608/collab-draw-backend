const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============================================
// GAME CONSTANTS
// ============================================
const DEFENSE_PHASE_DURATION = 15; // seconds
const ATTACK_PHASE_DURATION = 30; // seconds
const TOTAL_ROUNDS = 4;
const POINTS_TARGET_REACHED = 100;
const POINTS_PER_DISTANCE = 0.5;
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 650;

// ============================================
// STATE
// ============================================
let queue = []; // Players waiting for match
let games = {}; // Active games

// ============================================
// UTILITIES
// ============================================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function broadcast(game, data, exclude = null) {
    const message = JSON.stringify(data);
    game.players.forEach(player => {
        if (player.ws !== exclude && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

function broadcastToTeam(game, team, data) {
    const message = JSON.stringify(data);
    game.players.forEach(player => {
        if (player.team === team && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

// ============================================
// MATCHMAKING
// ============================================
function addToQueue(ws, username) {
    const player = {
        ws,
        id: generateId(),
        username
    };

    queue.push(player);

    // Broadcast queue update to all in queue
    queue.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'queue_update',
                count: queue.length
            }));
        }
    });

    // Check if we have 4 players
    if (queue.length >= 4) {
        const gamePlayers = queue.splice(0, 4);
        createGame(gamePlayers);
    }

    return player;
}

function removeFromQueue(ws) {
    queue = queue.filter(p => p.ws !== ws);
}

// ============================================
// GAME CREATION
// ============================================
function createGame(gamePlayers) {
    const gameId = generateId();

    // Assign teams (first 2 = red, last 2 = blue)
    // Shuffle first for fairness
    const shuffled = gamePlayers.sort(() => Math.random() - 0.5);

    const players = shuffled.map((player, index) => ({
        ...player,
        team: index < 2 ? 'red' : 'blue',
        spawnIndex: index % 2
    }));

    const game = {
        id: gameId,
        players,
        state: {
            phase: 'waiting',
            round: 1,
            attackingTeam: 'red', // Red attacks first
            defendingTeam: 'blue',
            timeRemaining: 0,
            scores: { red: 0, blue: 0 }
        },
        lines: {
            permanent: [],
            fading: []
        },
        attackerPaths: {},
        roundTargetReached: false,
        timerInterval: null
    };

    games[gameId] = game;

    // Link players to game
    players.forEach(player => {
        player.ws.gameId = gameId;
        player.ws.playerId = player.id;
    });

    // Build players object for client
    const playersObj = {};
    players.forEach(p => {
        playersObj[p.id] = {
            id: p.id,
            username: p.username,
            team: p.team
        };
    });

    // Send game start to all players
    players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'game_start',
            gameId,
            yourId: player.id,
            yourTeam: player.team,
            spawnIndex: player.spawnIndex,
            players: playersObj
        }));
    });

    // Start first round after brief delay
    setTimeout(() => startRound(game), 1000);

    console.log(`Game ${gameId} created with players:`, players.map(p => `${p.username} (${p.team})`));
}

// ============================================
// GAME FLOW
// ============================================
function startRound(game) {
    game.state.phase = 'defense';
    game.state.timeRemaining = DEFENSE_PHASE_DURATION;
    game.roundTargetReached = false;
    game.attackerPaths = {};

    // Clear lines from previous round (but keep permanent lines?)
    // For now, clear all for new round
    game.lines = { permanent: [], fading: [] };

    // Notify phase change
    broadcast(game, {
        type: 'phase_change',
        phase: 'defense',
        round: game.state.round,
        attackingTeam: game.state.attackingTeam,
        defendingTeam: game.state.defendingTeam,
        duration: DEFENSE_PHASE_DURATION
    });

    // Start timer
    startTimer(game, DEFENSE_PHASE_DURATION, () => {
        startAttackPhase(game);
    });
}

function startAttackPhase(game) {
    game.state.phase = 'attack';
    game.state.timeRemaining = ATTACK_PHASE_DURATION;

    broadcast(game, {
        type: 'phase_change',
        phase: 'attack',
        round: game.state.round,
        attackingTeam: game.state.attackingTeam,
        defendingTeam: game.state.defendingTeam,
        duration: ATTACK_PHASE_DURATION
    });

    startTimer(game, ATTACK_PHASE_DURATION, () => {
        endRound(game);
    });
}

function startTimer(game, duration, callback) {
    if (game.timerInterval) {
        clearInterval(game.timerInterval);
    }

    game.state.timeRemaining = duration;

    game.timerInterval = setInterval(() => {
        game.state.timeRemaining--;

        // Sync timer every 5 seconds
        if (game.state.timeRemaining % 5 === 0 || game.state.timeRemaining <= 5) {
            broadcast(game, {
                type: 'timer_sync',
                time: game.state.timeRemaining
            });
        }

        if (game.state.timeRemaining <= 0) {
            clearInterval(game.timerInterval);
            callback();
        }
    }, 1000);
}

function endRound(game) {
    clearInterval(game.timerInterval);

    // Calculate round score
    const attackingTeam = game.state.attackingTeam;

    if (game.roundTargetReached) {
        game.state.scores[attackingTeam] += POINTS_TARGET_REACHED;
    } else {
        // Score based on max distance reached
        let maxDistance = 0;
        for (const path of Object.values(game.attackerPaths)) {
            if (path.maxDistance > maxDistance) {
                maxDistance = path.maxDistance;
            }
        }
        game.state.scores[attackingTeam] += Math.floor(maxDistance * POINTS_PER_DISTANCE);
    }

    broadcast(game, {
        type: 'score_update',
        scores: game.state.scores
    });

    // Check if game is over
    if (game.state.round >= TOTAL_ROUNDS) {
        endGame(game);
        return;
    }

    // Swap teams and start next round
    game.state.round++;
    const temp = game.state.attackingTeam;
    game.state.attackingTeam = game.state.defendingTeam;
    game.state.defendingTeam = temp;

    setTimeout(() => startRound(game), 2000);
}

function endGame(game) {
    game.state.phase = 'gameover';

    broadcast(game, {
        type: 'game_over',
        scores: game.state.scores,
        winner: game.state.scores.red > game.state.scores.blue ? 'red' :
            game.state.scores.blue > game.state.scores.red ? 'blue' : 'draw'
    });

    // Clean up game after delay
    setTimeout(() => {
        delete games[game.id];
        console.log(`Game ${game.id} ended and cleaned up`);
    }, 60000);
}

function handleTargetReached(game, playerId) {
    if (!game.roundTargetReached) {
        game.roundTargetReached = true;

        // End attack phase early
        clearInterval(game.timerInterval);

        broadcast(game, {
            type: 'target_reached',
            playerId
        });

        // Brief celebration delay, then end round
        setTimeout(() => endRound(game), 2000);
    }
}

// ============================================
// MESSAGE HANDLING
// ============================================
function handleMessage(ws, data) {
    try {
        const msg = JSON.parse(data);

        switch (msg.type) {
            case 'join_queue':
                addToQueue(ws, msg.username || 'Anonymous');
                break;

            case 'draw':
                handleDraw(ws, msg);
                break;

            case 'line_complete':
                handleLineComplete(ws, msg);
                break;

            case 'stunned':
                handleStunned(ws, msg);
                break;

            case 'target_reached':
                handleTargetReachedMsg(ws, msg);
                break;
        }
    } catch (e) {
        console.error('Error handling message:', e);
    }
}

function handleDraw(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    // Broadcast to other players
    broadcast(game, {
        type: 'draw_line',
        playerId: player.id,
        team: player.team,
        point: msg.point,
        inkType: msg.inkType
    }, ws);

    // Track attacker path for scoring
    if (player.team === game.state.attackingTeam && game.state.phase === 'attack') {
        if (!game.attackerPaths[player.id]) {
            game.attackerPaths[player.id] = { points: [], maxDistance: 0 };
        }
        game.attackerPaths[player.id].points.push(msg.point);

        // Calculate distance from target
        const targetX = CANVAS_WIDTH / 2;
        const targetY = CANVAS_HEIGHT / 2;
        const dist = Math.sqrt(
            Math.pow(msg.point.x - targetX, 2) +
            Math.pow(msg.point.y - targetY, 2)
        );
        const progress = CANVAS_WIDTH / 2 - dist;
        game.attackerPaths[player.id].maxDistance = Math.max(
            game.attackerPaths[player.id].maxDistance,
            progress
        );
    }
}

function handleLineComplete(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    // Store defender lines
    if (player.team === game.state.defendingTeam && game.state.phase === 'defense') {
        if (msg.inkType === 'fading') {
            game.lines.fading.push({
                ...msg.line,
                createdAt: Date.now()
            });
        } else {
            game.lines.permanent.push(msg.line);
        }
    }

    // Broadcast to other players so they can see completed lines
    broadcast(game, {
        type: 'line_complete',
        playerId: player.id,
        line: msg.line,
        inkType: msg.inkType
    }, ws);
}

function handleStunned(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    broadcast(game, {
        type: 'player_stunned',
        playerId: msg.playerId
    }, ws);
}

function handleTargetReachedMsg(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    handleTargetReached(game, msg.playerId);
}

// ============================================
// CONNECTION HANDLING
// ============================================
wss.on('connection', (ws) => {
    console.log('New connection');

    ws.on('message', (data) => {
        handleMessage(ws, data);
    });

    ws.on('close', () => {
        // Remove from queue if waiting
        removeFromQueue(ws);

        // Handle disconnection from active game
        if (ws.gameId && games[ws.gameId]) {
            const game = games[ws.gameId];
            const player = game.players.find(p => p.ws === ws);

            if (player) {
                console.log(`Player ${player.username} disconnected from game ${game.id}`);

                // Notify other players
                broadcast(game, {
                    type: 'player_disconnected',
                    playerId: player.id
                }, ws);

                // For now, just continue the game
                // In production, you might want to pause or end the game
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// ============================================
// CLEANUP
// ============================================
// Clean up fading lines periodically
setInterval(() => {
    const now = Date.now();
    for (const game of Object.values(games)) {
        game.lines.fading = game.lines.fading.filter(
            line => (now - line.createdAt) < 8000
        );
    }
}, 1000);

console.log(`Ink Wars server running on port ${PORT}`);
console.log('Waiting for players...');