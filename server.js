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

// Coin & Powerup Constants
const COIN_SPAWN_COUNT = 6;
const COIN_RADIUS = 18;
const PROTECTED_ZONE_RADIUS = 120;
const SPAWN_ZONE_RADIUS = 60;

const POWERUPS = {
    quickRecovery: { cost: 3, name: 'Quick Recovery', desc: 'Stun time reduced to 1s' },
    extraInk: { cost: 4, name: 'Extra Ink', desc: '+50% ink capacity' },
    biggerBlast: { cost: 5, name: 'Bigger Blast', desc: '+50% explosion radius' },
    speedDraw: { cost: 3, name: 'Speed Draw', desc: 'Ink drains 30% slower' }
};

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
        timerInterval: null,
        // Coin system
        coins: [],
        teamCoins: { red: 0, blue: 0 },
        activePowerups: { red: [], blue: [] }
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
            players: playersObj,
            powerupDefs: POWERUPS
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

    // Clear lines from previous round
    game.lines = { permanent: [], fading: [] };

    // Clear coins
    game.coins = [];

    // Clear powerups for the team that's NOW attacking (they need to collect fresh)
    const attackingTeam = game.state.attackingTeam;
    game.activePowerups[attackingTeam] = [];
    game.teamCoins[attackingTeam] = 0;

    // Notify phase change
    broadcast(game, {
        type: 'phase_change',
        phase: 'defense',
        round: game.state.round,
        attackingTeam: game.state.attackingTeam,
        defendingTeam: game.state.defendingTeam,
        duration: DEFENSE_PHASE_DURATION,
        teamCoins: game.teamCoins,
        activePowerups: game.activePowerups[attackingTeam]
    });

    // Start timer
    startTimer(game, DEFENSE_PHASE_DURATION, () => {
        startAttackPhase(game);
    });
}

function startAttackPhase(game) {
    game.state.phase = 'attack';
    game.state.timeRemaining = ATTACK_PHASE_DURATION;

    // Spawn coins for this attack phase
    game.coins = spawnCoins();

    // Clear team coins for fresh collection (powerups were already applied)
    const attackingTeam = game.state.attackingTeam;
    game.teamCoins[attackingTeam] = 0;

    broadcast(game, {
        type: 'phase_change',
        phase: 'attack',
        round: game.state.round,
        attackingTeam: game.state.attackingTeam,
        defendingTeam: game.state.defendingTeam,
        duration: ATTACK_PHASE_DURATION,
        coins: game.coins,
        activePowerups: game.activePowerups[attackingTeam]
    });

    startTimer(game, ATTACK_PHASE_DURATION, () => {
        endRound(game);
    });
}

function spawnCoins() {
    const coins = [];
    const centerX = CANVAS_WIDTH / 2;
    const centerY = CANVAS_HEIGHT / 2;

    for (let i = 0; i < COIN_SPAWN_COUNT; i++) {
        let x, y, valid;
        let attempts = 0;

        do {
            valid = true;
            // Spawn in middle area, avoiding edges and protected zone
            x = 150 + Math.random() * (CANVAS_WIDTH - 300);
            y = 80 + Math.random() * (CANVAS_HEIGHT - 160);

            // Check not in protected zone
            const distToCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
            if (distToCenter < PROTECTED_ZONE_RADIUS + 30) {
                valid = false;
            }

            // Check not in spawn zones
            const spawnPoints = [
                { x: 80, y: CANVAS_HEIGHT / 2 - 100 },
                { x: 80, y: CANVAS_HEIGHT / 2 + 100 },
                { x: CANVAS_WIDTH - 80, y: CANVAS_HEIGHT / 2 - 100 },
                { x: CANVAS_WIDTH - 80, y: CANVAS_HEIGHT / 2 + 100 }
            ];
            for (const spawn of spawnPoints) {
                const distToSpawn = Math.sqrt(Math.pow(x - spawn.x, 2) + Math.pow(y - spawn.y, 2));
                if (distToSpawn < SPAWN_ZONE_RADIUS + 30) {
                    valid = false;
                    break;
                }
            }

            // Check not too close to other coins
            for (const coin of coins) {
                const distToCoin = Math.sqrt(Math.pow(x - coin.x, 2) + Math.pow(y - coin.y, 2));
                if (distToCoin < 60) {
                    valid = false;
                    break;
                }
            }

            attempts++;
        } while (!valid && attempts < 50);

        if (valid) {
            coins.push({ id: i, x, y, collected: false });
        }
    }

    return coins;
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

            case 'explosion':
                handleExplosion(ws, msg);
                break;

            case 'attacker_reset':
                handleAttackerReset(ws, msg);
                break;

            case 'target_reached':
                handleTargetReachedMsg(ws, msg);
                break;

            case 'collect_coin':
                handleCoinCollect(ws, msg);
                break;

            case 'buy_powerup':
                handleBuyPowerup(ws, msg);
                break;
        }
    } catch (e) {
        console.error('Error handling message:', e);
    }
}

function handleCoinCollect(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    // Only attackers can collect coins
    if (player.team !== game.state.attackingTeam) return;
    if (game.state.phase !== 'attack') return;

    // Find the coin
    const coin = game.coins.find(c => c.id === msg.coinId && !c.collected);
    if (!coin) return;

    // Mark as collected
    coin.collected = true;
    game.teamCoins[player.team]++;

    // Broadcast to all players
    broadcast(game, {
        type: 'coin_collected',
        coinId: msg.coinId,
        playerId: player.id,
        team: player.team,
        teamCoins: game.teamCoins[player.team]
    });

    console.log(`${player.username} collected coin! Team ${player.team} now has ${game.teamCoins[player.team]} coins`);
}

function handleBuyPowerup(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    const powerupId = msg.powerupId;
    const powerup = POWERUPS[powerupId];

    if (!powerup) return;

    // Check if team can afford it
    const team = player.team;
    if (game.teamCoins[team] < powerup.cost) return;

    // Check if already purchased this round
    if (game.activePowerups[team].includes(powerupId)) return;

    // Deduct cost and activate
    game.teamCoins[team] -= powerup.cost;
    game.activePowerups[team].push(powerupId);

    // Broadcast to all players
    broadcast(game, {
        type: 'powerup_purchased',
        powerupId,
        team,
        teamCoins: game.teamCoins[team],
        activePowerups: game.activePowerups[team]
    });

    console.log(`Team ${team} purchased ${powerup.name}! Remaining coins: ${game.teamCoins[team]}`);
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
        playerId: msg.playerId,
        collisionPoint: msg.collisionPoint
    }, ws);
}

function handleExplosion(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    // Broadcast explosion to all other players so they can update their line arrays
    broadcast(game, {
        type: 'explosion',
        playerId: player.id,
        point: msg.point,
        radius: msg.radius
    }, ws);

    // Also update server-side line storage
    explodeServerLines(game, msg.point, msg.radius);
}

function explodeServerLines(game, point, radius) {
    // Helper to calculate distance
    const dist = (p1, p2) => Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));

    // Process permanent lines
    const newPermanent = [];
    for (const line of game.lines.permanent) {
        const segments = splitLineByExplosion(line, point, radius, dist);
        newPermanent.push(...segments);
    }
    game.lines.permanent = newPermanent;

    // Process fading lines
    const newFading = [];
    for (const line of game.lines.fading) {
        const segments = splitLineByExplosion(line, point, radius, dist);
        newFading.push(...segments);
    }
    game.lines.fading = newFading;
}

function splitLineByExplosion(line, explosionPoint, radius, distFunc) {
    const points = line.points;
    const remainingSegments = [];
    let currentSegment = [];

    for (let i = 0; i < points.length; i++) {
        const d = distFunc(points[i], explosionPoint);

        if (d > radius) {
            currentSegment.push(points[i]);
        } else {
            if (currentSegment.length >= 2) {
                remainingSegments.push({
                    ...line,
                    points: [...currentSegment]
                });
            }
            currentSegment = [];
        }
    }

    if (currentSegment.length >= 2) {
        remainingSegments.push({
            ...line,
            points: currentSegment
        });
    }

    return remainingSegments;
}

function handleTargetReachedMsg(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    handleTargetReached(game, msg.playerId);
}

function handleAttackerReset(ws, msg) {
    const game = games[ws.gameId];
    if (!game) return;

    const player = game.players.find(p => p.ws === ws);
    if (!player) return;

    // Clear this attacker's path on server
    if (game.attackerPaths[player.id]) {
        game.attackerPaths[player.id] = { points: [], maxDistance: 0 };
    }

    // Broadcast to other players
    broadcast(game, {
        type: 'attacker_reset',
        playerId: player.id
    }, ws);
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