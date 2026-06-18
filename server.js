const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let leaderboard = {}; 
let answeredUsers = new Set(); 

let globalGameState = {
    mode: 'demo', 
    boardState: null, 
    currentTurn: 'w', 
    arrows: [], 
    highlights: [], 
    currentQuiz: null,
    simulGames: {} 
};

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id);

    socket.on('join', (data) => {
        socket.username = data.name || 'Ẩn danh';
        socket.role = data.role; 
        
        if (socket.role === 'student' && !leaderboard[socket.username]) {
            leaderboard[socket.username] = { points: 0, totalTime: 0 };
        }
        
        io.emit('update_leaderboard', leaderboard);
        
        socket.emit('init_game_state', {
            ...globalGameState,
            timeLeft: globalGameState.currentQuiz ? Math.round((globalGameState.currentQuiz.endTime - Date.now()) / 1000) : 0,
            mySimulGame: globalGameState.mode === 'simul' ? globalGameState.simulGames[socket.username] : null
        });
        
        if (globalGameState.mode === 'quiz' && answeredUsers.has(socket.username)) {
            socket.emit('student_already_submitted');
        }
    });

    socket.on('coach_demo_move', (data) => {
        if (globalGameState.mode === 'demo') {
            globalGameState.boardState = data.boardState;
            globalGameState.currentTurn = data.currentTurn;
            socket.broadcast.emit('sync_demo_board', {
                boardState: data.boardState,
                currentTurn: data.currentTurn
            });
        }
    });

    socket.on('coach_sync_arrows', (arrows) => {
        if (globalGameState.mode === 'demo') {
            globalGameState.arrows = arrows;
            socket.broadcast.emit('update_student_arrows', arrows);
        }
    });

    socket.on('coach_sync_highlights', (highlights) => {
        if (globalGameState.mode === 'demo') {
            globalGameState.highlights = highlights;
            socket.broadcast.emit('update_student_highlights', highlights);
        }
    });

    // ================= SIMUL VỚI ĐỒNG HỒ VÀ MÀU QUÂN =================
    socket.on('start_simul', (data) => {
        globalGameState.mode = 'simul';
        globalGameState.boardState = data.boardState;
        globalGameState.simulGames = {};
        
        const startingTimeMs = data.minutes * 60 * 1000;
        const incMs = data.increment * 1000;

        for (let studentName in leaderboard) {
            globalGameState.simulGames[studentName] = {
                boardState: JSON.parse(JSON.stringify(data.boardState)), 
                turn: data.currentTurn, // Thế cờ hiện tại đang là lượt ai
                coachColor: data.coachColor,
                wTime: startingTimeMs,
                bTime: startingTimeMs,
                incMs: incMs,
                lastMoveTimestamp: Date.now(),
                status: 'playing',
                lastMove: null
            };
        }

        io.emit('simul_started', globalGameState.simulGames);
    });

    // Xử lý trừ thời gian và cộng giây
    function processSimulMoveTime(game) {
        let now = Date.now();
        let timeSpent = now - game.lastMoveTimestamp;
        if (game.turn === 'w') {
            game.wTime -= timeSpent;
            game.wTime += game.incMs;
        } else {
            game.bTime -= timeSpent;
            game.bTime += game.incMs;
        }
        game.lastMoveTimestamp = now;
    }

    socket.on('coach_simul_move', (data) => {
        if (globalGameState.mode === 'simul' && globalGameState.simulGames[data.student]) {
            let game = globalGameState.simulGames[data.student];
            processSimulMoveTime(game);
            
            game.boardState = data.boardState;
            game.turn = game.turn === 'w' ? 'b' : 'w';
            game.lastMove = data.moveStr;
            
            io.emit('simul_update_game', { student: data.student, game: game });
            io.emit('simul_update_coach_dashboard', globalGameState.simulGames);
        }
    });

    socket.on('student_simul_move', (data) => {
        if (globalGameState.mode === 'simul' && globalGameState.simulGames[socket.username]) {
            let game = globalGameState.simulGames[socket.username];
            processSimulMoveTime(game);
            
            game.boardState = data.boardState;
            game.turn = game.turn === 'w' ? 'b' : 'w';
            game.lastMove = data.moveStr;
            
            io.emit('simul_update_game', { student: socket.username, game: game });
            io.emit('simul_update_coach_dashboard', globalGameState.simulGames);
        }
    });

    // ================= CHẾ ĐỘ QUIZ =================
    socket.on('send_question', (data) => {
        let seconds = parseInt(data.seconds) || 30;
        globalGameState.mode = 'quiz';
        globalGameState.currentQuiz = {
            type: data.type, fen: data.fen, a: data.a, b: data.b, c: data.c, d: data.d,
            correctAnswer: data.correctAnswer, totalSeconds: seconds,
            startTime: Date.now(), endTime: Date.now() + (seconds * 1000)
        };
        answeredUsers.clear(); 
        io.emit('new_question', { ...globalGameState.currentQuiz, seconds: seconds });
    });

    socket.on('stop_quiz_mode', () => {
        globalGameState.mode = 'demo';
        globalGameState.currentQuiz = null;
        io.emit('switch_to_demo_mode', {
            boardState: globalGameState.boardState, currentTurn: globalGameState.currentTurn,
            arrows: globalGameState.arrows, highlights: globalGameState.highlights
        }); 
    });

    socket.on('submit_answer', (selectedAnswer) => {
        if (socket.role === 'coach' || globalGameState.mode !== 'quiz') return; 
        if (answeredUsers.has(socket.username)) return; 
        answeredUsers.add(socket.username); 

        let timeSpent = Math.round((Date.now() - globalGameState.currentQuiz.startTime) / 1000);
        if (timeSpent > globalGameState.currentQuiz.totalSeconds) timeSpent = globalGameState.currentQuiz.totalSeconds;

        const isCorrect = globalGameState.currentQuiz && selectedAnswer.trim().toLowerCase() === globalGameState.currentQuiz.correctAnswer.trim().toLowerCase();
        
        if (leaderboard[socket.username] !== undefined) {
            leaderboard[socket.username].totalTime += timeSpent;
            if (isCorrect) leaderboard[socket.username].points += 10;
        }

        io.emit('coach_receive', { name: socket.username, answer: selectedAnswer, isCorrect: isCorrect, timeSpent: timeSpent });
        io.emit('update_leaderboard', leaderboard);
    });

    socket.on('reset_scores', () => {
        for (let user in leaderboard) {
            leaderboard[user] = { points: 0, totalTime: 0 };
        }
        io.emit('update_leaderboard', leaderboard);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Đa luồng đang hoạt động tại cổng: ${PORT}`);
});