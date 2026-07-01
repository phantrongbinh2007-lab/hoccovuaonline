const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { SlidingWindowLimiter } = require('./lib/rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const startFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const DEFAULT_COACH_KEYS = {
    thaybinh: 'Thầy Bình',
    codung: 'Cô Dung',
    thayhiep: 'Thầy Hiệp',
    cothao: 'Cô Thảo',
};

function getCoachRegistry() {
    if (process.env.COACH_KEYS_JSON) {
        try {
            return JSON.parse(process.env.COACH_KEYS_JSON);
        } catch (e) {
            console.warn('COACH_KEYS_JSON không hợp lệ, dùng mật khẩu mặc định.');
        }
    }
    return DEFAULT_COACH_KEYS;
}

const coachRegistry = getCoachRegistry();

const ROOM_IDLE_MS =
    parseInt(process.env.ROOM_IDLE_HOURS || '4', 10) * 60 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const joinRateLimiter = new SlidingWindowLimiter(
    parseInt(process.env.RATE_JOIN_MAX || '12', 10),
    parseInt(process.env.RATE_JOIN_WINDOW_MS || '60000', 10)
);
const submitRateLimiter = new SlidingWindowLimiter(
    parseInt(process.env.RATE_SUBMIT_MAX || '8', 10),
    parseInt(process.env.RATE_SUBMIT_WINDOW_MS || '60000', 10)
);

/** @type {Map<string, object>} */
const rooms = new Map();

let simulTimeoutInterval = null;
let roomCleanupInterval = null;
let rateLimitPruneInterval = null;

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        rooms: rooms.size,
        uptime: Math.floor(process.uptime()),
        roomIdleHours: ROOM_IDLE_MS / (60 * 60 * 1000),
    });
});

function normalizeRoomId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (id.length < 2 || id.length > 32) return null;
    return id;
}

function createEmptyRoom() {
    return {
        lastActivityAt: Date.now(),
        globalGameState: {
            mode: 'demo',
            fen: startFEN,
            arrows: [],
            highlights: [],
            currentQuiz: null,
            simulGames: {},
            simulConfig: null,
            coachName: null,
        },
        leaderboard: {},
        answeredUsers: new Set(),
        quizRevealTimer: null,
        coachSocketId: null,
    };
}

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, createEmptyRoom());
    }
    const room = rooms.get(roomId);
    room.lastActivityAt = Date.now();
    return room;
}

function touchRoom(room) {
    if (room) room.lastActivityAt = Date.now();
}

function getRoomConnectionCount(roomId) {
    let count = 0;
    for (const [, sock] of io.sockets.sockets) {
        if (sock.roomId === roomId && sock.connected) count++;
    }
    return count;
}

function cleanupIdleRooms() {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
        if (getRoomConnectionCount(roomId) > 0) {
            room.lastActivityAt = now;
            continue;
        }
        if (now - room.lastActivityAt < ROOM_IDLE_MS) continue;

        if (room.quizRevealTimer) {
            clearTimeout(room.quizRevealTimer);
            room.quizRevealTimer = null;
        }
        rooms.delete(roomId);
        console.log(`Đã dọn phòng trống (idle): [${roomId}]`);
    }
}

function startRoomCleanup() {
    if (roomCleanupInterval) return;
    roomCleanupInterval = setInterval(cleanupIdleRooms, ROOM_CLEANUP_INTERVAL_MS);
}

function startRateLimitPrune() {
    if (rateLimitPruneInterval) return;
    rateLimitPruneInterval = setInterval(() => {
        joinRateLimiter.prune();
        submitRateLimiter.prune();
    }, 5 * 60 * 1000);
}

function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address || socket.id;
}

function emitToRoom(roomId, event, data) {
    io.to(roomId).emit(event, data);
}

function getConnectedStudentCount(room) {
    return Object.keys(room.leaderboard).length;
}

function notifyCoachRoomStats(roomId, room) {
    if (!room.coachSocketId) return;
    io.to(room.coachSocketId).emit('room_stats', {
        studentCount: getConnectedStudentCount(room),
    });
}

function isStudentNameTakenInRoom(roomId, name, exceptSocketId) {
    for (const [, sock] of io.sockets.sockets) {
        if (
            sock.id !== exceptSocketId &&
            sock.roomId === roomId &&
            sock.role === 'student' &&
            sock.username === name &&
            sock.connected
        ) {
            return true;
        }
    }
    return false;
}

function createSimulGame(room, studentName) {
    const cfg = room.globalGameState.simulConfig;
    const startingTimeMs = cfg ? cfg.startingTimeMs : 5 * 60 * 1000;
    const incMs = cfg ? cfg.incMs : 5000;
    return {
        fen: cfg ? cfg.fen : startFEN,
        coachColor: cfg ? cfg.coachColor : 'w',
        wTime: startingTimeMs,
        bTime: startingTimeMs,
        incMs,
        lastMoveTimestamp: Date.now(),
        status: 'playing',
        lastMove: null,
        lastMoveFrom: null,
        lastMoveTo: null,
        winner: null,
        endReason: null,
    };
}

function getGameResultText(game) {
    if (game.status === 'checkmate') {
        const winnerIsCoach = game.winner === game.coachColor;
        return winnerIsCoach ? 'HLV thắng (chiếu hết)' : 'Học trò thắng (chiếu hết)';
    }
    if (game.status === 'timeout') {
        const winnerIsCoach = game.winner === game.coachColor;
        return winnerIsCoach ? 'HLV thắng (hết giờ)' : 'Học trò thắng (hết giờ)';
    }
    if (game.status === 'resigned') {
        const winnerIsCoach = game.winner === game.coachColor;
        return winnerIsCoach ? 'Học trò đầu hàng' : 'HLV đầu hàng';
    }
    if (game.status === 'draw') return 'Cờ hòa';
    return '';
}

function applySimulMove(game, data) {
    if (game.status !== 'playing') return { ok: false, error: 'game_over' };

    const chess = new Chess(game.fen);
    let move = null;

    if (data.from && data.to) {
        move = chess.move({
            from: data.from,
            to: data.to,
            promotion: data.promotion || 'q',
        });
    } else if (data.moveStr) {
        move = chess.move(data.moveStr);
    }

    if (!move) return { ok: false, error: 'illegal_move' };

    const colorMoved = move.color;
    const now = Date.now();
    const timeSpent = now - game.lastMoveTimestamp;
    if (colorMoved === 'w') {
        game.wTime -= timeSpent;
        game.wTime += game.incMs;
    } else {
        game.bTime -= timeSpent;
        game.bTime += game.incMs;
    }
    game.lastMoveTimestamp = now;

    game.fen = chess.fen();
    game.lastMove = move.san;
    game.lastMoveFrom = move.from;
    game.lastMoveTo = move.to;

    if (chess.in_checkmate()) {
        game.status = 'checkmate';
        game.winner = move.color;
        game.endReason = 'checkmate';
    } else if (chess.in_draw()) {
        game.status = 'draw';
        game.endReason = 'draw';
        game.winner = null;
    }

    return { ok: true, move };
}

function checkSimulTimeout(game) {
    if (game.status !== 'playing') return false;

    const tColor = game.fen.split(' ')[1];
    const now = Date.now();
    const elapsed = now - game.lastMoveTimestamp;
    let wTime = game.wTime;
    let bTime = game.bTime;

    if (tColor === 'w') wTime -= elapsed;
    else bTime -= elapsed;

    if (wTime <= 0) {
        game.status = 'timeout';
        game.winner = 'b';
        game.endReason = 'timeout';
        return true;
    }
    if (bTime <= 0) {
        game.status = 'timeout';
        game.winner = 'w';
        game.endReason = 'timeout';
        return true;
    }
    return false;
}

function checkAllSimulTimeouts() {
    for (const [roomId, room] of rooms) {
        const gs = room.globalGameState;
        if (gs.mode !== 'simul') continue;

        let changed = false;
        for (const studentName in gs.simulGames) {
            if (checkSimulTimeout(gs.simulGames[studentName])) {
                changed = true;
                emitToRoom(roomId, 'simul_update_game', {
                    student: studentName,
                    game: gs.simulGames[studentName],
                    resultText: getGameResultText(gs.simulGames[studentName]),
                });
            }
        }
        if (changed) emitToRoom(roomId, 'simul_update_coach_dashboard', gs.simulGames);
    }
}

function startSimulTimeoutChecker() {
    if (simulTimeoutInterval) return;
    simulTimeoutInterval = setInterval(checkAllSimulTimeouts, 1000);
}

function parseMoveToSan(fen, input) {
    if (!input || !fen) return null;
    const s = input.trim();
    const chess = new Chess(fen);

    let m = chess.move(s);
    if (m) return m.san;

    chess.load(fen);
    const cleaned = s.replace(/\s/g, '');
    const uci = cleaned.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
    if (uci) {
        const opts = { from: uci[1], to: uci[2] };
        if (uci[3]) opts.promotion = uci[3].toLowerCase();
        m = chess.move(opts);
        if (m) return m.san;
    }

    chess.load(fen);
    const dash = s.match(/^([a-h][1-8])\s*[-x]\s*([a-h][1-8])(=[QRBN])?$/i);
    if (dash) {
        const opts = { from: dash[1], to: dash[2] };
        if (dash[3]) opts.promotion = dash[3][1].toLowerCase();
        m = chess.move(opts);
        if (m) return m.san;
    }

    return null;
}

function checkQuizAnswer(quiz, selectedAnswer) {
    if (!quiz) return false;
    if (quiz.type === 'quiz') {
        return selectedAnswer.trim().toLowerCase() === quiz.correctAnswer.trim().toLowerCase();
    }
    const studentSan = parseMoveToSan(quiz.fen, selectedAnswer);
    const correctSan = quiz.normalizedAnswer || parseMoveToSan(quiz.fen, quiz.correctAnswer);
    if (studentSan && correctSan) {
        return studentSan.toLowerCase() === correctSan.toLowerCase();
    }
    return selectedAnswer.trim().toLowerCase() === quiz.correctAnswer.trim().toLowerCase();
}

function buildQuizRevealPayload(room) {
    const gs = room.globalGameState;
    const quiz = gs.currentQuiz;
    if (!quiz) return null;

    const submissions = quiz.submissions || [];
    const correctCount = submissions.filter((s) => s.isCorrect).length;
    const totalStudents = Object.keys(room.leaderboard).length;

    return {
        correctAnswer: quiz.correctAnswer,
        displayAnswer: quiz.displayAnswer || quiz.correctAnswer,
        normalizedAnswer: quiz.normalizedAnswer || null,
        type: quiz.type,
        fen: quiz.fen,
        stats: {
            submitted: submissions.length,
            correct: correctCount,
            total: totalStudents,
            percentage: submissions.length ? Math.round((correctCount / submissions.length) * 100) : 0,
        },
        submissions,
    };
}

function revealQuiz(roomId, room) {
    const gs = room.globalGameState;
    if (!gs.currentQuiz || gs.currentQuiz.revealed) return;

    gs.currentQuiz.revealed = true;
    if (room.quizRevealTimer) {
        clearTimeout(room.quizRevealTimer);
        room.quizRevealTimer = null;
    }

    const payload = buildQuizRevealPayload(room);
    if (payload) emitToRoom(roomId, 'quiz_revealed', payload);
}

function buildInitPayload(room, username) {
    const gs = room.globalGameState;
    const initPayload = {
        ...gs,
        roomId: null,
        timeLeft: gs.currentQuiz
            ? Math.max(0, Math.round((gs.currentQuiz.endTime - Date.now()) / 1000))
            : 0,
        mySimulGame: gs.mode === 'simul' ? gs.simulGames[username] : null,
        coachName: gs.coachName || null,
        coachOnline: !!room.coachSocketId,
    };

    if (gs.currentQuiz?.revealed) {
        initPayload.quizReveal = buildQuizRevealPayload(room);
    }

    return initPayload;
}

function getRoom(socket) {
    if (!socket.roomId) return null;
    const room = rooms.get(socket.roomId) || null;
    if (room) touchRoom(room);
    return room;
}

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id);

    socket.on('join', (data) => {
        const clientIp = getClientIp(socket);
        if (!joinRateLimiter.allow(clientIp)) {
            socket.emit('join_error', {
                message: 'Quá nhiều lần thử vào lớp. Vui lòng đợi khoảng 1 phút rồi thử lại.',
            });
            return;
        }

        const roomId = normalizeRoomId(data.roomId);
        if (!roomId) {
            socket.emit('join_error', { message: 'Mã lớp không hợp lệ (2–32 ký tự, chữ/số).' });
            return;
        }

        const room = getOrCreateRoom(roomId);

        if (data.role === 'coach') {
            const coachKey = (data.coachKey || '').trim().toLowerCase();
            if (!coachKey || !coachRegistry[coachKey]) {
                socket.emit('join_error', { message: 'Sai mật khẩu HLV! Từ chối truy cập.' });
                return;
            }
            data.name = coachRegistry[coachKey];

            if (room.coachSocketId && room.coachSocketId !== socket.id) {
                const existingCoach = io.sockets.sockets.get(room.coachSocketId);
                if (existingCoach && existingCoach.connected) {
                    socket.emit('join_error', { message: 'Lớp này đã có HLV đang dạy. Chọn mã lớp khác.' });
                    return;
                }
            }
            room.coachSocketId = socket.id;
            room.globalGameState.coachName = data.name || 'HLV';
        }

        socket.roomId = roomId;
        socket.username = data.name || 'Ẩn danh';
        socket.role = data.role;
        socket.join(roomId);

        if (socket.role === 'student') {
            if (isStudentNameTakenInRoom(roomId, socket.username, socket.id)) {
                socket.emit('join_error', {
                    message: `Tên "${socket.username}" đã có trong lớp. Hãy thêm họ hoặc số để phân biệt.`,
                });
                socket.leave(roomId);
                return;
            }
            if (!room.leaderboard[socket.username]) {
                room.leaderboard[socket.username] = { points: 0, totalTime: 0 };
            }
        }

        const gs = room.globalGameState;
        if (
            socket.role === 'student' &&
            gs.mode === 'simul' &&
            gs.simulConfig &&
            !gs.simulGames[socket.username]
        ) {
            gs.simulGames[socket.username] = createSimulGame(room, socket.username);
            emitToRoom(roomId, 'simul_update_coach_dashboard', gs.simulGames);
        }

        emitToRoom(roomId, 'update_leaderboard', room.leaderboard);
        notifyCoachRoomStats(roomId, room);

        const initPayload = buildInitPayload(room, socket.username);
        initPayload.roomId = roomId;
        socket.emit('init_game_state', initPayload);

        if (socket.role === 'coach') {
            socket.emit('room_info', {
                roomId,
                joinUrl: `?lop=${roomId}`,
                studentCount: getConnectedStudentCount(room),
            });
            emitToRoom(roomId, 'coach_online', { coachName: gs.coachName });
            notifyCoachRoomStats(roomId, room);
        }

        if (gs.mode === 'quiz' && room.answeredUsers.has(socket.username)) {
            socket.emit('student_already_submitted');
            if (gs.currentQuiz?.revealed) {
                const sub = (gs.currentQuiz.submissions || []).find((s) => s.name === socket.username);
                if (sub) socket.emit('student_quiz_result', sub);
            }
        }

        console.log(`${socket.username} (${socket.role}) vào lớp [${roomId}]`);
    });

    socket.on('disconnect', () => {
        if (!socket.roomId || socket.role !== 'coach') return;
        const room = rooms.get(socket.roomId);
        if (room && room.coachSocketId === socket.id) {
            room.coachSocketId = null;
            emitToRoom(socket.roomId, 'coach_offline', {});
        }
    });

    socket.on('coach_set_name', (name) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach' || !name) return;
        room.globalGameState.coachName = name;
        emitToRoom(socket.roomId, 'coach_name_updated', name);
    });

    socket.on('coach_demo_move', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;
        const gs = room.globalGameState;
        if (gs.mode === 'demo') {
            gs.fen = data.fen;
            socket.to(socket.roomId).emit('sync_demo_board', {
                fen: data.fen,
                lastMoveFrom: data.lastMoveFrom || null,
                lastMoveTo: data.lastMoveTo || null,
            });
        }
    });

    socket.on('coach_reset_demo_board', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;
        const gs = room.globalGameState;
        if (gs.mode !== 'demo') return;

        const fen = (data && data.fen) || startFEN;
        gs.fen = fen;
        gs.arrows = [];
        gs.highlights = [];

        emitToRoom(socket.roomId, 'demo_board_reset', {
            fen,
            arrows: [],
            highlights: [],
        });
    });

    socket.on('coach_sync_arrows', (arrows) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;
        const gs = room.globalGameState;
        if (gs.mode === 'demo') {
            gs.arrows = arrows;
            socket.to(socket.roomId).emit('update_student_arrows', arrows);
        }
    });

    socket.on('coach_sync_highlights', (highlights) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;
        const gs = room.globalGameState;
        if (gs.mode === 'demo') {
            gs.highlights = highlights;
            socket.to(socket.roomId).emit('update_student_highlights', highlights);
        }
    });

    socket.on('start_simul', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;

        const gs = room.globalGameState;
        gs.mode = 'simul';
        gs.fen = data.fen;
        gs.simulGames = {};

        const startingTimeMs = data.minutes * 60 * 1000;
        const incMs = data.increment * 1000;
        gs.simulConfig = {
            fen: data.fen,
            coachColor: data.coachColor,
            minutes: data.minutes,
            increment: data.increment,
            startingTimeMs,
            incMs,
        };

        for (const studentName in room.leaderboard) {
            gs.simulGames[studentName] = createSimulGame(room, studentName);
        }
        startSimulTimeoutChecker();
        emitToRoom(socket.roomId, 'simul_started', gs.simulGames);
    });

    socket.on('coach_simul_move', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;

        const gs = room.globalGameState;
        if (gs.mode !== 'simul' || !gs.simulGames[data.student]) return;

        const game = gs.simulGames[data.student];
        const result = applySimulMove(game, data);
        if (!result.ok) return;

        emitToRoom(socket.roomId, 'simul_update_game', {
            student: data.student,
            game,
            resultText: game.status !== 'playing' ? getGameResultText(game) : null,
        });
        emitToRoom(socket.roomId, 'simul_update_coach_dashboard', gs.simulGames);
    });

    socket.on('student_simul_move', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'student') return;

        const gs = room.globalGameState;
        if (gs.mode !== 'simul' || !gs.simulGames[socket.username]) return;

        const game = gs.simulGames[socket.username];
        const result = applySimulMove(game, data);
        if (!result.ok) return;

        emitToRoom(socket.roomId, 'simul_update_game', {
            student: socket.username,
            game,
            resultText: game.status !== 'playing' ? getGameResultText(game) : null,
        });
        emitToRoom(socket.roomId, 'simul_update_coach_dashboard', gs.simulGames);
    });

    socket.on('simul_resign', (data) => {
        const room = getRoom(socket);
        if (!room) return;

        const gs = room.globalGameState;
        if (gs.mode !== 'simul') return;

        const studentName = socket.role === 'coach' ? data.student : socket.username;
        const game = gs.simulGames[studentName];
        if (!game || game.status !== 'playing') return;

        const studentColor = game.coachColor === 'w' ? 'b' : 'w';
        if (socket.role === 'student') {
            game.status = 'resigned';
            game.winner = game.coachColor;
            game.endReason = 'resigned';
        } else if (socket.role === 'coach') {
            game.status = 'resigned';
            game.winner = studentColor;
            game.endReason = 'resigned';
        }

        emitToRoom(socket.roomId, 'simul_update_game', {
            student: studentName,
            game,
            resultText: getGameResultText(game),
        });
        emitToRoom(socket.roomId, 'simul_update_coach_dashboard', gs.simulGames);
    });

    socket.on('send_question', (data) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;

        const gs = room.globalGameState;
        const seconds = parseInt(data.seconds, 10) || 30;
        const normalizedAnswer =
            data.type === 'text' ? parseMoveToSan(data.fen, data.correctAnswer) : null;
        const displayAnswer =
            data.type === 'text' && normalizedAnswer ? normalizedAnswer : data.correctAnswer;

        gs.mode = 'quiz';
        gs.currentQuiz = {
            type: data.type,
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            correctAnswer: data.correctAnswer,
            normalizedAnswer,
            displayAnswer,
            totalSeconds: seconds,
            startTime: Date.now(),
            endTime: Date.now() + seconds * 1000,
            revealed: false,
            submissions: [],
        };
        room.answeredUsers.clear();

        if (room.quizRevealTimer) clearTimeout(room.quizRevealTimer);
        const quizStartTime = gs.currentQuiz.startTime;
        room.quizRevealTimer = setTimeout(() => {
            const r = rooms.get(socket.roomId);
            if (
                r &&
                r.globalGameState.mode === 'quiz' &&
                r.globalGameState.currentQuiz &&
                r.globalGameState.currentQuiz.startTime === quizStartTime
            ) {
                revealQuiz(socket.roomId, r);
            }
        }, seconds * 1000);

        emitToRoom(socket.roomId, 'new_question', { ...gs.currentQuiz, seconds });
    });

    socket.on('reveal_quiz', () => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;
        if (room.globalGameState.mode === 'quiz') revealQuiz(socket.roomId, room);
    });

    socket.on('stop_quiz_mode', () => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;

        const gs = room.globalGameState;
        if (gs.mode === 'quiz' && gs.currentQuiz && !gs.currentQuiz.revealed) {
            revealQuiz(socket.roomId, room);
        }

        gs.mode = 'demo';
        gs.currentQuiz = null;
        gs.simulConfig = null;
        gs.simulGames = {};

        if (room.quizRevealTimer) {
            clearTimeout(room.quizRevealTimer);
            room.quizRevealTimer = null;
        }

        emitToRoom(socket.roomId, 'switch_to_demo_mode', {
            fen: gs.fen,
            arrows: gs.arrows,
            highlights: gs.highlights,
        });
    });

    socket.on('submit_answer', (selectedAnswer) => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'student' || room.globalGameState.mode !== 'quiz') return;
        if (!submitRateLimiter.allow(socket.id)) {
            socket.emit('action_error', {
                message: 'Em thao tác quá nhanh. Hãy đợi vài giây rồi thử lại.',
            });
            return;
        }
        if (room.answeredUsers.has(socket.username)) return;
        room.answeredUsers.add(socket.username);

        const gs = room.globalGameState;
        const quiz = gs.currentQuiz;
        let timeSpent = Math.round((Date.now() - quiz.startTime) / 1000);
        if (timeSpent > quiz.totalSeconds) timeSpent = quiz.totalSeconds;

        const isCorrect = checkQuizAnswer(quiz, selectedAnswer);
        const studentSan =
            quiz.type === 'text' ? parseMoveToSan(quiz.fen, selectedAnswer) : null;

        if (room.leaderboard[socket.username] !== undefined) {
            room.leaderboard[socket.username].totalTime += timeSpent;
            if (isCorrect) room.leaderboard[socket.username].points += 10;
        }

        const submission = {
            name: socket.username,
            answer: selectedAnswer,
            normalizedAnswer: studentSan,
            isCorrect,
            timeSpent,
        };
        quiz.submissions.push(submission);

        emitToRoom(socket.roomId, 'coach_receive', {
            name: socket.username,
            answer: selectedAnswer,
            normalizedAnswer: studentSan,
            isCorrect,
            timeSpent,
        });
        emitToRoom(socket.roomId, 'update_leaderboard', room.leaderboard);

        socket.emit('student_quiz_pending', { isCorrect: null });

        if (quiz.revealed) {
            socket.emit('student_quiz_result', submission);
        }
    });

    socket.on('reset_scores', () => {
        const room = getRoom(socket);
        if (!room || socket.role !== 'coach') return;

        for (const user in room.leaderboard) {
            room.leaderboard[user] = { points: 0, totalTime: 0 };
        }
        emitToRoom(socket.roomId, 'update_leaderboard', room.leaderboard);
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`Máy chủ Chess Arena đang hoạt động tại cổng: ${PORT}`);
    startSimulTimeoutChecker();
    startRoomCleanup();
    startRateLimitPrune();
});
