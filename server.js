const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let leaderboard = {}; 
let currentQuestion = null; // Bộ nhớ lưu câu hỏi đang diễn ra
let answeredUsers = new Set(); // Sổ Nam Tào lưu những bé ĐÃ NỘP BÀI câu hiện tại

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id);

    socket.on('join', (data) => {
        socket.username = data.name || 'Ẩn danh';
        socket.role = data.role; // Phân biệt HLV và Học trò ngay từ đầu
        
        // VẤN ĐỀ 3: Chỉ thêm vào Bảng Vàng nếu role là 'student' (Học trò)
        if (socket.role === 'student' && !leaderboard[socket.username]) {
            leaderboard[socket.username] = 0;
        }
        
        io.emit('update_leaderboard', leaderboard);

        // VẤN ĐỀ 1: Học trò văng mạng vào lại, hoặc vào trễ
        // Nếu có câu hỏi đang chạy và thời gian chưa kết thúc, gửi riêng cho bé này
        if (currentQuestion && socket.role === 'student') {
            let timeLeft = Math.round((currentQuestion.endTime - Date.now()) / 1000);
            if (timeLeft > 0 && !answeredUsers.has(socket.username)) {
                socket.emit('new_question', {
                    fen: currentQuestion.fen,
                    a: currentQuestion.a,
                    b: currentQuestion.b,
                    c: currentQuestion.c,
                    d: currentQuestion.d,
                    seconds: timeLeft // Chỉ cấp cho thời gian còn sót lại của câu hỏi
                });
            }
        }
    });

    socket.on('send_question', (data) => {
        let seconds = parseInt(data.seconds) || 30;
        
        // Lưu lại trạng thái câu hỏi lên bộ nhớ Server
        currentQuestion = {
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            correctAnswer: data.correctAnswer,
            endTime: Date.now() + (seconds * 1000) // Mốc thời gian kết thúc
        };
        
        // Xóa sạch sổ Nam Tào để chuẩn bị cho câu mới
        answeredUsers.clear(); 
        
        io.emit('new_question', {
            fen: data.fen,
            a: data.a,
            b: data.b,
            c: data.c,
            d: data.d,
            seconds: seconds
        });
    });

    socket.on('submit_answer', (selectedOption) => {
        if (socket.role === 'coach') return; // Đề phòng HLV bấm lộn

        // VẤN ĐỀ 2 (Khóa phía Server): Nếu đã có tên trong sổ thì ngó lơ lệnh này luôn
        if (answeredUsers.has(socket.username)) {
            return; 
        }
        answeredUsers.add(socket.username); // Chưa có thì ghi danh vào sổ

        const isCorrect = currentQuestion && selectedOption === currentQuestion.correctAnswer;
        
        // Trả lời đúng thì cộng điểm
        if (isCorrect && leaderboard[socket.username] !== undefined) {
            leaderboard[socket.username] += 10;
        }

        io.emit('coach_receive', {
            name: socket.username,
            answer: selectedOption,
            isCorrect: isCorrect
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
    console.log(`Hệ thống đang chạy tại cổng: ${PORT}`);
});