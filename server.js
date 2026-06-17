const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let leaderboard = {}; 
let currentQuestion = null; 
let answeredUsers = new Set(); 

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id);

    socket.on('join', (data) => {
        socket.username = data.name || 'Ẩn danh';
        socket.role = data.role; 
        
        if (socket.role === 'student' && !leaderboard[socket.username]) {
            leaderboard[socket.username] = 0;
        }
        
        io.emit('update_leaderboard', leaderboard);

        if (currentQuestion && socket.role === 'student') {
            let timeLeft = Math.round((currentQuestion.endTime - Date.now()) / 1000);
            if (timeLeft > 0 && !answeredUsers.has(socket.username)) {
                socket.emit('new_question', {
                    type: currentQuestion.type,
                    fen: currentQuestion.fen,
                    a: currentQuestion.a,
                    b: currentQuestion.b,
                    c: currentQuestion.c,
                    d: currentQuestion.d,
                    seconds: timeLeft
                });
            }
        }
    });

    socket.on('send_question', (data) => {
        let seconds = parseInt(data.seconds) || 30;
        
        currentQuestion = {
            type: data.type,
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            correctAnswer: data.correctAnswer, 
            totalSeconds: seconds,
            startTime: Date.now(), // Lưu mốc thời gian bắt đầu câu hỏi
            endTime: Date.now() + (seconds * 1000)
        };
        
        answeredUsers.clear(); 
        
        io.emit('new_question', {
            type: data.type,
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            seconds: seconds
        });
    });

    socket.on('submit_answer', (selectedAnswer) => {
        if (socket.role === 'coach') return; 

        if (answeredUsers.has(socket.username)) {
            return; 
        }
        answeredUsers.add(socket.username); 

        // Tính số giây học trò đã dùng để suy nghĩ
        let timeSpent = Math.round((Date.now() - currentQuestion.startTime) / 1000);
        if (timeSpent > currentQuestion.totalSeconds) {
            timeSpent = currentQuestion.totalSeconds;
        }

        const isCorrect = currentQuestion && selectedAnswer === currentQuestion.correctAnswer;
        
        if (isCorrect && leaderboard[socket.username] !== undefined) {
            leaderboard[socket.username] += 10;
        }

        // Báo kết quả kèm thời gian suy nghĩ về cho HLV
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
            leaderboard[user] = 0;
        }
        io.emit('update_leaderboard', leaderboard);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`He thong do thoi gian dang chay tai cong: ${PORT}`);
});