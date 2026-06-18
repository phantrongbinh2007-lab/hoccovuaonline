const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let leaderboard = {}; 
let answeredUsers = new Set(); 

// TRẠNG THÁI HỆ THỐNG TOÀN CỤC CHUẨN HOÁ
let globalGameState = {
    mode: 'demo', 
    boardState: null, 
    currentTurn: 'w', 
    arrows: [], 
    currentQuiz: null 
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
        
        // Gửi trạng thái kèm thời gian còn lại chính xác cho học trò vào sau hoặc rớt mạng
        socket.emit('init_game_state', {
            ...globalGameState,
            timeLeft: globalGameState.currentQuiz ? Math.round((globalGameState.currentQuiz.endTime - Date.now()) / 1000) : 0
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
        // SỬA LỖI NaN: Gửi kèm biến seconds tường minh cho client tiếp nhận
        io.emit('new_question', { ...globalGameState.currentQuiz, seconds: seconds });
    });

    socket.on('stop_quiz_mode', () => {
        globalGameState.mode = 'demo';
        globalGameState.currentQuiz = null;
        io.emit('switch_to_demo_mode', {
            boardState: globalGameState.boardState,
            currentTurn: globalGameState.currentTurn,
            arrows: globalGameState.arrows
        }); 
    });

    socket.on('submit_answer', (selectedAnswer) => {
        if (socket.role === 'coach' || globalGameState.mode !== 'quiz') return; 

        if (answeredUsers.has(socket.username)) return; 
        answeredUsers.add(socket.username); 

        let timeSpent = Math.round((Date.now() - globalGameState.currentQuiz.startTime) / 1000);
        if (timeSpent > globalGameState.currentQuiz.totalSeconds) {
            timeSpent = globalGameState.currentQuiz.totalSeconds;
        }

        const isCorrect = globalGameState.currentQuiz && selectedAnswer.trim().toLowerCase() === globalGameState.currentQuiz.correctAnswer.trim().toLowerCase();
        
        if (leaderboard[socket.username] !== undefined) {
            leaderboard[socket.username].totalTime += timeSpent;
            if (isCorrect) {
                leaderboard[socket.username].points += 10;
            }
        }

        io.emit('coach_receive', {
            name: socket.username,
            answer: selectedAnswer,
            isCorrect: isCorrect,
            timeSpent: timeSpent
        });

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
    console.log(`Server uu hoa dang chay tai cong: ${PORT}`);
});