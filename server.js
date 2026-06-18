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
    mode: 'demo', // 'demo', 'quiz', hoặc 'simul'
    boardState: null, 
    currentTurn: 'w', 
    arrows: [], 
    highlights: [], 
    currentQuiz: null,
    simulGames: {} // Kho lưu trữ N ván cờ đồng loạt { 'Tuấn Kiệt': { boardState, currentTurn, status... } }
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
        
        // Gửi toàn bộ trạng thái hệ thống cho người mới
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

    // ================= TÍNH NĂNG MỚI: ĐẤU ĐỒNG LOẠT (SIMUL) =================
    socket.on('start_simul', (data) => {
        globalGameState.mode = 'simul';
        globalGameState.boardState = data.boardState;
        globalGameState.simulGames = {};
        
        let coachColor = data.currentTurn; // Lấy lượt đi hiện tại của HLV làm mốc (Thường thầy cầm Trắng sẽ đi trước)

        // Phân thân bàn cờ cho từng học trò đang có mặt trong Leaderboard
        for (let studentName in leaderboard) {
            globalGameState.simulGames[studentName] = {
                boardState: JSON.parse(JSON.stringify(data.boardState)), // Copy độc lập
                turn: data.currentTurn, // Trắng hay Đen đi tiếp
                coachColor: coachColor,
                lastMove: null
            };
        }

        io.emit('simul_started', globalGameState.simulGames);
    });

    socket.on('coach_simul_move', (data) => {
        if (globalGameState.mode === 'simul' && globalGameState.simulGames[data.student]) {
            let game = globalGameState.simulGames[data.student];
            game.boardState = data.boardState;
            game.turn = game.turn === 'w' ? 'b' : 'w';
            game.lastMove = data.moveStr;
            
            // Bắn trạng thái cập nhật xuống cho riêng học trò đó
            io.emit('simul_update_student', { student: data.student, game: game });
            // Cập nhật lại Trạm chỉ huy của HLV
            io.emit('simul_update_coach_dashboard', globalGameState.simulGames);
        }
    });

    socket.on('student_simul_move', (data) => {
        if (globalGameState.mode === 'simul' && globalGameState.simulGames[socket.username]) {
            let game = globalGameState.simulGames[socket.username];
            game.boardState = data.boardState;
            game.turn = game.turn === 'w' ? 'b' : 'w';
            game.lastMove = data.moveStr;
            
            // Bắn cho học trò đó để khóa bảng
            socket.emit('simul_update_student', { student: socket.username, game: game });
            // Bắn lên Trạm chỉ huy của HLV để báo đèn xanh 🟢
            io.emit('simul_update_coach_dashboard', globalGameState.simulGames);
        }
    });

    // ================= CHẾ ĐỘ CÂU HỎI (QUIZ) =================
    socket.on('send_question', (data) => {
        let seconds = parseInt(data.seconds) || 30;
        globalGameState.mode = 'quiz';
        globalGameState.currentQuiz = {
            type: data.type,
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            correctAnswer: data.correctAnswer, 
            totalSeconds: seconds,
            startTime: Date.now(), 
            endTime: Date.now() + (seconds * 1000)
        };
        answeredUsers.clear(); 
        io.emit('new_question', { ...globalGameState.currentQuiz, seconds: seconds });
    });

    socket.on('stop_quiz_mode', () => {
        globalGameState.mode = 'demo';
        globalGameState.currentQuiz = null;
        io.emit('switch_to_demo_mode', {
            boardState: globalGameState.boardState,
            currentTurn: globalGameState.currentTurn,
            arrows: globalGameState.arrows,
            highlights: globalGameState.highlights
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
    console.log(`Hệ thống Đa luồng đang hoạt động tại cổng: ${PORT}`);
});