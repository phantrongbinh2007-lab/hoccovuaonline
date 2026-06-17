const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Lưu trữ bảng điểm Grand Prix trong bộ nhớ Server
let leaderboard = {}; 
let currentCorrectAnswer = '';

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id);

    // Học trò hoặc HLV tham gia phòng
    socket.on('join', (name) => {
        socket.username = name || 'Ẩn danh';
        
        // Nếu là học trò và chưa có trong Bảng Vàng thì khởi tạo 0 điểm
        if (name !== 'HLV' && !leaderboard[socket.username]) {
            leaderboard[socket.username] = 0;
        }
        
        // Gửi Bảng Vàng cập nhật cho tất cả mọi người
        io.emit('update_leaderboard', leaderboard);
    });

    // HLV phát đề bài mới (Gồm thế cờ FEN, 4 đáp án, đáp án đúng và thời gian)
    socket.on('send_question', (data) => {
        currentCorrectAnswer = data.correctAnswer; // Lưu đáp án đúng hiện tại (A, B, C hoặc D)
        
        // Phát dữ liệu câu hỏi tới tất cả học trò
        io.emit('new_question', {
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            seconds: parseInt(data.seconds) || 30
        });
    });

    // Học trò nộp đáp án câu hỏi
    socket.on('submit_answer', (selectedOption) => {
        const isCorrect = selectedOption === currentCorrectAnswer;
        
        // Nếu trả lời đúng thì cộng 10 điểm vào hệ thống Grand Prix
        if (isCorrect && socket.username && leaderboard[socket.username] !== undefined) {
            leaderboard[socket.username] += 10;
        }

        // Báo kết quả riêng câu này cho HLV biết
        io.emit('coach_receive', {
            name: socket.username,
            answer: selectedOption,
            isCorrect: isCorrect
        });

        // Cập nhật lại Bảng Vàng cho cả lớp cùng thấy sự thay đổi thứ hạng
        io.emit('update_leaderboard', leaderboard);
    });

    // Tính năng cho phép HLV reset toàn bộ điểm số Bảng Vàng về 0
    socket.on('reset_scores', () => {
        for (let user in leaderboard) {
            leaderboard[user] = 0;
        }
        io.emit('update_leaderboard', leaderboard);
    });
});

// Sử dụng cổng của môi trường (Render) hoặc mặc định là 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hệ thống đang chạy tại cổng: ${PORT}`);
});