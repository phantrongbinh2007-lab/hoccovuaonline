const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });

        function updateConnectionBanner(state, message) {
            const banner = document.getElementById('connection-banner');
            banner.classList.remove('hidden', 'connecting', 'disconnected', 'connected');
            banner.classList.add(state);
            banner.textContent = message;
            if (state === 'connected') {
                setTimeout(() => banner.classList.add('hidden'), 2000);
            }
        }

        socket.on('connect', () => {
            updateConnectionBanner('connected', '✅ Đã kết nối lại máy chủ');
            if (myName && myRoomId) {
                const payload = { name: myName, role: myRole, roomId: myRoomId };
                if (myRole === 'coach' && myCoachKey) payload.coachKey = myCoachKey;
                socket.emit('join', payload);
            }
        });
        socket.io.on('reconnect_attempt', () => {
            updateConnectionBanner('connecting', '🔄 Đang kết nối lại...');
        });
        socket.on('disconnect', () => {
            updateConnectionBanner('disconnected', '⚠️ Mất kết nối — đang thử kết nối lại...');
        });
        let myRole = '';
        let myName = '';
        let myRoomId = '';
        let myCoachKey = '';
        let hasJoinedRoom = false;
        let countdownInterval = null;
        let simulClockTickInterval = null; 
        
        // ================= KHỞI TẠO BỘ NÃO CHESS.JS =================
        const chessEngine = new Chess();
        const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        
        let selectedSquare = null;
        let legalMoveSquares = [];
        let lastMoveFrom = null;
        let lastMoveTo = null;
        let pendingPromotion = null;
        let currentRecordedMove = '';
        let currentSystemMode = 'demo';
        let coachDisplayName = 'HLV';
        let lastStudentQuizSubmission = null;

        let studyTree = new StudyTree(startFEN);
        
        let coachArrows = []; 
        let coachHighlights = []; 
        let rightClickStartSquare = null; 
        
        let activeSimulGames = {};
        let currentSimulOpponent = null; 
        let mySimulCoachColor = 'w';
        let mySimulGameData = null; 

        const pieceImages = {
            'P': 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg',
            'R': 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg',
            'N': 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg',
            'B': 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg',
            'Q': 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg',
            'K': 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg',
            'p': 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg',
            'r': 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg',
            'n': 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg',
            'b': 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg',
            'q': 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg',
            'k': 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg'
        };

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function updateStudentCountBadge(count) {
            const el = document.getElementById('coach-student-count');
            if (!el) return;
            el.textContent = '👥 ' + count + ' học trò';
            el.classList.remove('hidden');
        }

        (function initRoomFromUrl() {
            const params = new URLSearchParams(window.location.search);
            const fromUrl = params.get('lop') || params.get('room') || '';
            if (fromUrl) document.getElementById('room-code').value = fromUrl;
        })();

        function normalizeRoomInput(raw) {
            return (raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        }

        function updateRoomBadgeUI(roomId) {
            const label = 'Lớp: ' + roomId;
            const s = document.getElementById('student-room-badge');
            const c = document.getElementById('coach-room-badge');
            if (s) s.textContent = label;
            if (c) c.textContent = label;
        }

        function showCoachRoomLink(roomId) {
            const base = window.location.origin + window.location.pathname;
            const link = base + '?lop=' + encodeURIComponent(roomId);
            document.getElementById('coach-room-link-text').textContent = link;
            document.getElementById('coach-room-link-box').classList.remove('hidden');
        }

        function copyRoomLink() {
            const text = document.getElementById('coach-room-link-text').textContent;
            navigator.clipboard.writeText(text).then(() => alert('Đã sao chép link lớp!')).catch(() => prompt('Sao chép link này:', text));
        }

        socket.on('join_error', (data) => {
            alert(data.message || 'Không vào được lớp.');
            hasJoinedRoom = false;
            myName = '';
            myRole = '';
            myCoachKey = '';
            document.getElementById('login-screen').classList.remove('hidden');
            document.getElementById('student-screen').classList.add('hidden');
            document.getElementById('coach-screen').classList.add('hidden');
            document.getElementById('leaderboard-area').classList.add('hidden');
        });

        socket.on('action_error', (data) => {
            alert(data.message || 'Thao tác không hợp lệ.');
        });

        socket.on('room_info', (data) => {
            if (myRole !== 'coach') return;
            myRoomId = data.roomId;
            updateRoomBadgeUI(data.roomId);
            showCoachRoomLink(data.roomId);
            updateStudentCountBadge(data.studentCount || 0);
        });

        socket.on('room_stats', (data) => {
            if (myRole === 'coach') updateStudentCountBadge(data.studentCount || 0);
        });

        socket.on('coach_online', (data) => {
            if (myRole !== 'student') return;
            if (data.coachName) updateCoachNameInUI(data.coachName);
            document.getElementById('student-status').innerText = `${coachDisplayName} đã vào lớp — đang đồng bộ bài giảng...`;
        });

        socket.on('coach_offline', () => {
            if (myRole !== 'student') return;
            document.getElementById('student-status').innerText = '⏳ Thầy tạm ngắt kết nối — em chờ thầy quay lại nhé...';
        });

        function joinRoom(role) {
            const roomInput = normalizeRoomInput(document.getElementById('room-code').value);
            if (!roomInput || roomInput.length < 2) {
                alert('Vui lòng nhập mã lớp (ít nhất 2 ký tự, ví dụ: thaybinh, lop-a).');
                return;
            }

            let nameInput = document.getElementById('username').value.trim();
            if (role === 'student' && !nameInput) {
                alert('Học trò vui lòng điền tên trước khi vào lớp!');
                return;
            }
            if (role === 'coach') {
                const pass = prompt('Vui lòng nhập mật khẩu Huấn Luyện Viên:');
                if (!pass) return;
                myCoachKey = pass.trim().toLowerCase();
            } else {
                myCoachKey = '';
                myName = nameInput;
            }

            myRoomId = roomInput;
            myRole = role;
            if (role === 'student') myName = nameInput;
            updateRoomBadgeUI(myRoomId);

            const joinPayload = { name: myName, role: myRole, roomId: myRoomId };
            if (role === 'coach') joinPayload.coachKey = myCoachKey;
            socket.emit('join', joinPayload);

            if (role === 'coach') {
                showCoachRoomLink(myRoomId);
            }
        }

        function updateCoachNameInUI(name) {
            coachDisplayName = name || 'HLV';
            document.querySelectorAll('.coach-name-label').forEach((el) => { el.textContent = coachDisplayName; });
            const selfEl = document.getElementById('coach-self-name');
            if (selfEl) selfEl.textContent = coachDisplayName;
        }

        // ================= STUDY PGN (LICHESS-STYLE) =================
        function applyStudyPosition() {
            const fen = studyTree.getCurrentFen();
            loadAndDrawFEN(fen, 'coach-board', currentSystemMode === 'demo');
            renderStudyMoveList();
            if (currentSystemMode === 'demo') syncCoachStateToServ();
        }

        function goToStudyNode(node) {
            studyTree.goTo(node);
            applyStudyPosition();
        }

        function studyFirst() { studyTree.goToRoot(); applyStudyPosition(); }
        function studyBack() { studyTree.goToParent(); applyStudyPosition(); }
        function studyForward() { studyTree.goToChild(0); applyStudyPosition(); }
        function studyLast() { studyTree.goToEnd(); applyStudyPosition(); }

        function isStartingFen(fen) {
            if (!fen) return true;
            return fen.split(' ')[0] === startFEN.split(' ')[0];
        }

        function resetStudyTree(fen, options) {
            const opts = options || {};
            const targetFen = fen || startFEN;
            const skipConfirm = opts.skipConfirm === true;
            const skipServerSync = opts.skipServerSync === true;

            if (
                !skipConfirm &&
                myRole === 'coach' &&
                currentSystemMode === 'demo' &&
                !isStartingFen(chessEngine.fen()) &&
                isStartingFen(targetFen) &&
                !confirm('Reset bàn cờ về vị trí xuất phát (ván mới)? Thế cờ hiện tại sẽ bị xóa.')
            ) {
                return;
            }

            studyTree.reset(targetFen);
            studyTree.headers.White = coachDisplayName;
            studyTree.headers.Black = 'Học trò';
            chessEngine.load(studyTree.getCurrentFen());
            lastMoveFrom = null;
            lastMoveTo = null;
            coachArrows = [];
            coachHighlights = [];

            const modeSelect = document.getElementById('board-setup-mode');
            if (modeSelect && modeSelect.value !== 'starting') {
                modeSelect.value = 'starting';
                document.getElementById('pgn-input-wrapper').classList.remove('hidden');
                document.getElementById('fen-input-wrapper').classList.add('hidden');
            }
            const fenInput = document.getElementById('input-fen');
            if (fenInput) fenInput.value = '';

            loadAndDrawFEN(studyTree.getCurrentFen(), 'coach-board', currentSystemMode === 'demo');
            renderStudyMoveList();
            drawArrowsOnSvg('coach-arrows-svg', []);

            if (currentSystemMode === 'demo' && myRole === 'coach' && !skipServerSync) {
                socket.emit('coach_reset_demo_board', { fen: targetFen });
            }
        }

        function renderMoveBranch(node, moveNum, isWhite) {
            const container = document.createElement('span');
            node.children.forEach((child, idx) => {
                if (idx > 0) {
                    const varWrap = document.createElement('span');
                    varWrap.className = 'move-variation';
                    varWrap.appendChild(document.createTextNode('('));
                    const altStart = document.createElement('span');
                    const num = document.createElement('span');
                    num.className = 'move-num';
                    num.textContent = isWhite ? moveNum + '.' : moveNum + '...';
                    altStart.appendChild(num);
                    const sanAlt = document.createElement('span');
                    sanAlt.className = 'move-san' + (studyTree.current === child ? ' move-current' : '');
                    sanAlt.textContent = child.san + ' ';
                    sanAlt.onclick = () => goToStudyNode(child);
                    altStart.appendChild(sanAlt);
                    altStart.appendChild(renderMoveBranch(child, isWhite ? moveNum : moveNum + 1, !isWhite));
                    varWrap.appendChild(altStart);
                    varWrap.appendChild(document.createTextNode(') '));
                    container.appendChild(varWrap);
                    return;
                }
                if (isWhite) {
                    const num = document.createElement('span');
                    num.className = 'move-num';
                    num.textContent = moveNum + '.';
                    container.appendChild(num);
                }
                const san = document.createElement('span');
                san.className = 'move-san' + (studyTree.current === child ? ' move-current' : '');
                san.textContent = child.san + ' ';
                san.onclick = () => goToStudyNode(child);
                container.appendChild(san);
                container.appendChild(renderMoveBranch(child, isWhite ? moveNum : moveNum + 1, !isWhite));
            });
            return container;
        }

        function renderStudyMoveList() {
            const el = document.getElementById('study-move-list');
            if (!el) return;
            el.innerHTML = '';
            if (studyTree.root.children.length === 0) {
                el.innerHTML = '<span style="color:#95a5a6;">Chưa có nước đi — hãy bốc cờ hoặc tải file PGN lên.</span>';
                return;
            }
            el.appendChild(renderMoveBranch(studyTree.root, 1, true));
        }

        function uploadPgnFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    studyTree.loadFromPgn(e.target.result);
                    applyStudyPosition();
                    alert('Đã tải PGN thành công!');
                } catch (err) {
                    alert('Không đọc được file PGN: ' + err.message);
                }
                event.target.value = '';
            };
            reader.readAsText(file);
        }

        function downloadPgn() {
            studyTree.headers.White = coachDisplayName;
            studyTree.headers.Date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
            const pgn = studyTree.exportPgn();
            const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'bai-giang-' + new Date().toISOString().slice(0, 10) + '.pgn';
            a.click();
            URL.revokeObjectURL(a.href);
        }

        document.addEventListener('keydown', (e) => {
            if (myRole !== 'coach' || currentSystemMode !== 'demo') return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); studyBack(); }
            if (e.key === 'ArrowRight') { e.preventDefault(); studyForward(); }
            if (e.key === 'Home') { e.preventDefault(); studyFirst(); }
            if (e.key === 'End') { e.preventDefault(); studyLast(); }
        });

        // ================= GIAO TIẾP VỚI CHESS.JS ENGINE =================
        function getCheckSquare() {
            if (!chessEngine.in_check()) return null;
            const color = chessEngine.turn();
            const files = 'abcdefgh';
            for (let r = 1; r <= 8; r++) {
                for (let f = 0; f < 8; f++) {
                    const sq = files[f] + r;
                    const p = chessEngine.get(sq);
                    if (p && p.type === 'k' && p.color === color) return sq;
                }
            }
            return null;
        }

        function clearBoardSelection() {
            selectedSquare = null;
            legalMoveSquares = [];
        }

        function selectSquare(square, boardId) {
            selectedSquare = square;
            const moves = chessEngine.moves({ square, verbose: true });
            legalMoveSquares = moves.map((m) => ({ to: m.to, capture: !!m.captured }));
            renderBoardGraphics(boardId, true);
        }

        function showPromotionModal(pieceColor, callback) {
            const modal = document.getElementById('promotion-modal');
            const container = document.getElementById('promotion-pieces');
            container.innerHTML = '';
            const pieces = [
                { code: 'q', label: 'Hậu' },
                { code: 'r', label: 'Xe' },
                { code: 'b', label: 'Tượng' },
                { code: 'n', label: 'Mã' },
            ];
            const colorChar = pieceColor === 'w' ? pieceColor.toUpperCase() : pieceColor;
            pieces.forEach((p) => {
                const btn = document.createElement('button');
                btn.title = p.label;
                const imgKey = p.code === p.code.toLowerCase() ? p.code : p.code;
                const imgChar = pieceColor === 'w' ? p.code.toUpperCase() : p.code;
                btn.innerHTML = `<img src="${pieceImages[imgChar]}" alt="${p.label}">`;
                btn.onclick = () => {
                    modal.classList.add('hidden');
                    callback(p.code);
                };
                container.appendChild(btn);
            });
            modal.classList.remove('hidden');
        }

        function isSimulGameActive(boardId) {
            if (currentSystemMode !== 'simul') return true;
            let game = null;
            if (boardId === 'student-board') game = mySimulGameData;
            else if (boardId === 'coach-board' && currentSimulOpponent) game = activeSimulGames[currentSimulOpponent];
            return game && game.status === 'playing';
        }

        function executeMove(fromSquare, toSquare, boardId, promotion) {
            if (!isSimulGameActive(boardId)) return;

            const moveOpts = { from: fromSquare, to: toSquare };
            if (promotion) moveOpts.promotion = promotion;

            const fenBefore = chessEngine.fen();
            const moveResult = chessEngine.move(moveOpts);
            if (moveResult === null) {
                chessEngine.load(fenBefore);
                const piece = chessEngine.get(toSquare);
                if (piece && piece.color === chessEngine.turn()) selectSquare(toSquare, boardId);
                return;
            }

            lastMoveFrom = moveResult.from;
            lastMoveTo = moveResult.to;
            clearBoardSelection();

            const moveStr = moveResult.san;
            const isClickable = boardId === 'coach-board' || (boardId === 'student-board' && currentSystemMode === 'simul');
            renderBoardGraphics(boardId, isClickable);
            updateTurnBadge();

            let statusAlert = '';
            if (chessEngine.in_checkmate()) statusAlert = ' 🛑 CHIẾU HẾT!';
            else if (chessEngine.in_draw()) statusAlert = ' 🤝 CỜ HÒA!';
            else if (chessEngine.in_check()) statusAlert = ' ⚠️ CHIẾU!';

            const movePayload = {
                from: moveResult.from,
                to: moveResult.to,
                promotion: moveResult.promotion,
                moveStr,
            };

            if (boardId === 'coach-board') {
                if (currentSystemMode === 'demo') {
                    studyTree.addMove(moveStr, chessEngine.fen());
                    renderStudyMoveList();
                    syncCoachStateToServ();
                    if (statusAlert) alert(statusAlert.trim());
                } else if (currentSystemMode === 'simul') {
                    socket.emit('coach_simul_move', { student: currentSimulOpponent, ...movePayload });
                    autoSwitchSimulBoard();
                }
            } else if (boardId === 'student-board' && currentSystemMode === 'simul') {
                document.getElementById('student-status').innerHTML = `🔄 Em đã đi [<b>${moveStr}</b>]. Đang đợi ${coachDisplayName}...${statusAlert}`;
                socket.emit('student_simul_move', movePayload);
            }
        }

        function loadAndDrawFEN(fen, boardId, isClickable, moveFrom, moveTo) {
            let validation = chessEngine.load(fen);
            if (!validation) chessEngine.load(startFEN);
            if (arguments.length >= 4) {
                lastMoveFrom = moveFrom;
                lastMoveTo = moveTo;
            }
            clearBoardSelection();
            renderBoardGraphics(boardId, isClickable);
            updateTurnBadge();
        }

        function renderBoardGraphics(boardId, isClickable) {
            const boardDiv = document.getElementById(boardId);
            if (!boardDiv) return;
            boardDiv.innerHTML = '';
            const files = ['a','b','c','d','e','f','g','h'];
            const checkSq = getCheckSquare();

            let orientation = 'w';
            if (currentSystemMode === 'simul') {
                if (myRole === 'student') orientation = (mySimulCoachColor === 'w') ? 'b' : 'w';
                else if (myRole === 'coach') orientation = mySimulCoachColor;
            }
            renderBoardCoordinates(boardId, orientation);

            let simulClickable = isClickable;
            if (currentSystemMode === 'simul' && isClickable) {
                simulClickable = isSimulGameActive(boardId);
            }

            for (let r = 0; r < 8; r++) {
                const rank = (orientation === 'w') ? 8 - r : r + 1;
                for (let f = 0; f < 8; f++) {
                    const file = (orientation === 'w') ? files[f] : files[7 - f];
                    const square = file + rank;

                    const squareDiv = document.createElement('div');
                    let highlightClass = '';
                    if (coachHighlights.includes(square) && (boardId === 'coach-board' || (boardId === 'student-board' && currentSystemMode === 'demo'))) {
                        highlightClass += ' highlighted-danger';
                    }
                    if (square === selectedSquare) highlightClass += ' selected';
                    if (square === lastMoveFrom || square === lastMoveTo) highlightClass += ' last-move';
                    if (square === checkSq) highlightClass += ' in-check';
                    const legalInfo = legalMoveSquares.find((m) => m.to === square);
                    if (legalInfo) highlightClass += legalInfo.capture ? ' legal-move legal-capture' : ' legal-move';

                    squareDiv.className = 'square ' + ((r + f) % 2 === 0 ? 'light' : 'dark') + highlightClass;
                    squareDiv.dataset.square = square;
                    squareDiv.dataset.row = r;
                    squareDiv.dataset.col = f;

                    let pieceObj = chessEngine.get(square);
                    if (pieceObj) {
                        let pChar = pieceObj.color === 'w' ? pieceObj.type.toUpperCase() : pieceObj.type.toLowerCase();
                        if (pieceImages[pChar]) {
                            const img = document.createElement('img');
                            img.src = pieceImages[pChar];
                            img.className = 'piece-img';
                            img.draggable = false;
                            squareDiv.appendChild(img);
                        }
                    }

                    if (simulClickable) squareDiv.onclick = () => handleSquareInteraction(square, boardId);

                    if (boardId === 'coach-board' && currentSystemMode === 'demo') {
                        squareDiv.onmousedown = (e) => { if (e.button === 2) rightClickStartSquare = square; };
                        squareDiv.onmouseup = (e) => {
                            if (e.button === 2 && rightClickStartSquare) {
                                if (rightClickStartSquare !== square) addCoachArrow(rightClickStartSquare, square);
                                else toggleCoachSquareHighlight(square);
                                rightClickStartSquare = null;
                            }
                        };
                    }
                    boardDiv.appendChild(squareDiv);
                }
            }
        }

        function renderBoardCoordinates(boardId, orientation) {
            const prefix = boardId.replace('-board', '');
            const ranksEl = document.getElementById(prefix + '-coord-ranks');
            const filesEl = document.getElementById(prefix + '-coord-files');
            if (!ranksEl || !filesEl) return;
            const fileLabels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
            const rankLabels = orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
            const fileOrder = orientation === 'w' ? fileLabels : fileLabels.slice().reverse();
            ranksEl.innerHTML = rankLabels.map((r) => `<span>${r}</span>`).join('');
            filesEl.innerHTML = fileOrder.map((f) => `<span>${f}</span>`).join('');
        }

        // ================= XỬ LÝ LƯỢT ĐI QUA ENGINE CHUẨN =================
        function handleSquareInteraction(square, boardId) {
            if (boardId === 'student-board') {
                if (currentSystemMode !== 'simul') return;
                if (!isSimulGameActive(boardId)) return;
                let isMyTurn = (chessEngine.turn() === 'w' && mySimulCoachColor === 'b') || (chessEngine.turn() === 'b' && mySimulCoachColor === 'w');
                if (!isMyTurn) return;
            }
            if (boardId === 'coach-board' && currentSystemMode === 'simul' && !isSimulGameActive(boardId)) return;

            if (!selectedSquare) {
                let pieceObj = chessEngine.get(square);
                if (pieceObj && pieceObj.color === chessEngine.turn()) {
                    selectSquare(square, boardId);
                }
                return;
            }

            const fromSquare = selectedSquare;
            const toSquare = square;
            if (fromSquare === toSquare) {
                clearBoardSelection();
                renderBoardGraphics(boardId, true);
                return;
            }

            const pieceObj = chessEngine.get(fromSquare);
            const isPromotion = pieceObj && pieceObj.type === 'p' && (toSquare[1] === '8' || toSquare[1] === '1');
            clearBoardSelection();

            if (isPromotion) {
                showPromotionModal(pieceObj.color, (promo) => executeMove(fromSquare, toSquare, boardId, promo));
            } else {
                executeMove(fromSquare, toSquare, boardId);
            }
        }

        function updateTurnBadge() {
            let turnText = chessEngine.turn() === 'w' ? "Lượt Trắng" : "Lượt Đen";
            if (myRole === 'student') document.getElementById('student-turn-badge').innerText = `Lượt đi: ${turnText}`;
            else document.getElementById('coach-turn-badge').innerText = `Lượt đi: ${turnText}`;
        }

        // ================= CÔNG CỤ SVG & QUẢN LÝ LỊCH SỬ =================
        function toggleCoachSquareHighlight(square) {
            const idx = coachHighlights.indexOf(square);
            if (idx !== -1) coachHighlights.splice(idx, 1); else coachHighlights.push(square);
            renderBoardGraphics('coach-board', true); socket.emit('coach_sync_highlights', coachHighlights);
        }

        function addCoachArrow(from, to) {
            const index = coachArrows.findIndex(a => a.from === from && a.to === to);
            if (index !== -1) coachArrows.splice(index, 1); else coachArrows.push({ from, to });
            drawArrowsOnSvg('coach-arrows-svg', coachArrows); socket.emit('coach_sync_arrows', coachArrows);
        }

        function clearCoachMarkings() {
            coachArrows = []; coachHighlights = [];
            drawArrowsOnSvg('coach-arrows-svg', coachArrows); renderBoardGraphics('coach-board', true);
            socket.emit('coach_sync_arrows', coachArrows); socket.emit('coach_sync_highlights', coachHighlights);
        }

        function drawArrowsOnSvg(svgId, arrowsList) {
            const svg = document.getElementById(svgId); if (!svg) return;
            svg.innerHTML = ''; 
            if (arrowsList.length > 0) {
                svg.innerHTML += `<defs><marker id="arrow-head" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto"><path d="M0,0 L0,6 L5,3 Z" fill="rgba(22, 160, 133, 0.75)" /></marker></defs>`;
            }
            arrowsList.forEach(arrow => {
                const fromEl = document.querySelector(`#${svgId.replace('-arrows-svg', '-board')} [data-square="${arrow.from}"]`);
                const toEl = document.querySelector(`#${svgId.replace('-arrows-svg', '-board')} [data-square="${arrow.to}"]`);
                if (fromEl && toEl) {
                    let fRow = parseInt(fromEl.dataset.row), fCol = parseInt(fromEl.dataset.col);
                    let tRow = parseInt(toEl.dataset.row), tCol = parseInt(toEl.dataset.col);
                    let x1 = (fCol + 0.5) * 12.5, y1 = (fRow + 0.5) * 12.5;
                    let x2 = (tCol + 0.5) * 12.5, y2 = (tRow + 0.5) * 12.5;
                    let dx = x2 - x1, dy = y2 - y1; let len = Math.sqrt(dx*dx + dy*dy);
                    if (len > 0) { x2 = x1 + (dx / len) * (len - 4); y2 = y1 + (dy / len) * (len - 4); }
                    svg.innerHTML += `<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%" stroke="rgba(22, 160, 133, 0.75)" stroke-width="8" marker-end="url(#arrow-head)" />`;
                }
            });
        }

        function syncCoachStateToServ() {
            socket.emit('coach_demo_move', {
                fen: chessEngine.fen(),
                lastMoveFrom,
                lastMoveTo,
            });
        }

        function handleBoardSetupModeChange() {
            const mode = document.getElementById('board-setup-mode').value;
            if (mode === 'starting') {
                document.getElementById('pgn-input-wrapper').classList.remove('hidden'); document.getElementById('fen-input-wrapper').classList.add('hidden');
                resetStudyTree(startFEN, { skipConfirm: true });
            } else {
                document.getElementById('pgn-input-wrapper').classList.add('hidden'); document.getElementById('fen-input-wrapper').classList.remove('hidden');
                let fen = document.getElementById('input-fen').value.trim() || startFEN;
                resetStudyTree(fen, { skipConfirm: true });
            }
        }

        function toggleCoachInputs() {
            const type = document.getElementById('input-type').value;
            if (type === 'quiz') { document.getElementById('area-quiz-inputs').classList.remove('hidden'); document.getElementById('area-move-inputs').classList.add('hidden'); }
            else { document.getElementById('area-quiz-inputs').classList.add('hidden'); document.getElementById('area-move-inputs').classList.remove('hidden'); }
        }

        document.getElementById('input-fen').addEventListener('input', function(e) {
            let fen = e.target.value.trim() || startFEN;
            resetStudyTree(fen);
        });

        // ================= ĐIỀU PHỐI SIMUL =================
        function enterSimulUILayout() {
            document.getElementById('coach-demo-tools').classList.add('hidden');
            document.getElementById('coach-stop-tools').classList.remove('hidden');
            document.getElementById('btn-stop-simul').classList.remove('hidden');
            document.getElementById('btn-coach-resign').classList.remove('hidden');
            document.getElementById('btn-reveal-quiz').classList.add('hidden');
            document.getElementById('panel-title-logs').innerText = "Trạm Điều Phối Bàn Đấu Simul:";
            document.getElementById('coach-logs').classList.add('hidden');
            document.getElementById('coach-simul-dashboard').classList.remove('hidden');
            document.getElementById('coach-simul-header').classList.remove('hidden');
            document.getElementById('coach-mode-badge').innerText = "⚔️ TRẠNG THÁI: ĐẤU ĐỒNG LOẠT VỚI LỚP (SIMUL)";
            document.getElementById('coach-mode-badge').style.background = "#f5eef8";
            document.getElementById('coach-mode-badge').style.color = "#8e44ad";
            document.getElementById('timer-coach').classList.add('hidden');
            document.getElementById('coach-top-clock-bar').classList.remove('hidden');
            document.getElementById('coach-bottom-clock-bar').classList.remove('hidden');
        }

        function startSimulClockTicker() {
            if (simulClockTickInterval) clearInterval(simulClockTickInterval);
            simulClockTickInterval = setInterval(updateSimulClockVisuals, 200);
        }

        function restoreSimulFromServer(simulGames, simulConfig) {
            currentSystemMode = 'simul';
            enterSimulUILayout();
            if (simulConfig) mySimulCoachColor = simulConfig.coachColor;
            activeSimulGames = simulGames || {};
            renderCoachSimulDashboard(activeSimulGames);
            startSimulClockTicker();
        }

        function startSimulMode() {
            enterSimulUILayout();
            clearCoachMarkings();

            mySimulCoachColor = document.getElementById('simul-coach-color').value;
            let mins = document.getElementById('simul-minutes').value;
            let incs = document.getElementById('simul-increment').value;

            socket.emit('start_simul', { fen: chessEngine.fen(), coachColor: mySimulCoachColor, minutes: mins, increment: incs });
            startSimulClockTicker();
        }

        function loadSimulGameOnCoachBoard(studentName) {
            currentSimulOpponent = studentName;
            document.getElementById('current-simul-opponent-name').innerText = studentName;

            let game = activeSimulGames[studentName];
            if (game) {
                const clickable = game.status === 'playing';
                loadAndDrawFEN(game.fen, 'coach-board', clickable, game.lastMoveFrom, game.lastMoveTo);
                document.querySelectorAll('.simul-item').forEach(el => el.classList.remove('active'));
                let btn = document.getElementById('simul-btn-' + studentName.replace(/[^a-zA-Z0-9\u00C0-\u024F_-]/g, '_'));
                if (btn) btn.classList.add('active');
            }
        }

        function getSimulStatusLabel(game) {
            if (!game || game.status === 'playing') return null;
            if (game.status === 'checkmate') return game.winner === game.coachColor ? '✅ HLV thắng' : '🏆 Học trò thắng';
            if (game.status === 'timeout') return game.winner === game.coachColor ? '⏱️ HLV thắng (giờ)' : '⏱️ Học trò thắng (giờ)';
            if (game.status === 'resigned') return game.winner === game.coachColor ? '🏳️ Học trò đầu hàng' : '🏳️ HLV đầu hàng';
            if (game.status === 'draw') return '🤝 Hòa';
            return 'Kết thúc';
        }

        function resignSimul() {
            if (!confirm('Em chắc chắn muốn đầu hàng không?')) return;
            socket.emit('simul_resign', {});
        }

        function coachResignSimul() {
            if (!currentSimulOpponent) return;
            if (!confirm(`Cho ${currentSimulOpponent} thắng (HLV đầu hàng)?`)) return;
            socket.emit('simul_resign', { student: currentSimulOpponent });
        }

        function revealQuizNow() {
            socket.emit('reveal_quiz');
        }

        function autoSwitchSimulBoard() {
            for (let studentName in activeSimulGames) {
                let game = activeSimulGames[studentName];
                let tColor = game.fen.split(' ')[1];
                if (tColor === game.coachColor) { loadSimulGameOnCoachBoard(studentName); return; }
            }
            if(Object.keys(activeSimulGames).length > 0) loadSimulGameOnCoachBoard(Object.keys(activeSimulGames)[0]);
        }

        function renderCoachSimulDashboard(simulGames) {
            activeSimulGames = simulGames;
            const dash = document.getElementById('coach-simul-dashboard'); dash.innerHTML = '';
            for (let studentName in simulGames) {
                let game = simulGames[studentName];
                let tColor = game.fen.split(' ')[1];
                let isCoachTurn = tColor === game.coachColor;
                
                let indicator = isCoachTurn ? '<span class="simul-indicator-green"></span>' : '<span class="simul-indicator-wait"></span>';
                let statusText = isCoachTurn ? '🟢 Đến lượt Thầy' : '⏳ Đang nghĩ...';
                const endLabel = getSimulStatusLabel(game);
                if (endLabel) statusText = `<span class="simul-ended-badge">${endLabel}</span>`;
                let activeClass = (studentName === currentSimulOpponent) ? 'active' : '';
                
                const btnId = 'simul-btn-' + studentName.replace(/[^a-zA-Z0-9\u00C0-\u024F_-]/g, '_');
                dash.innerHTML += `<div id="${btnId}" class="simul-item ${activeClass}" onclick="loadSimulGameOnCoachBoard(${JSON.stringify(studentName)})"><div style="font-weight:bold; color:#2c3e50;">👤 ${escapeHtml(studentName)}</div><div style="font-size:12px; color:#7f8c8d; display:flex; align-items:center; gap:5px;">${indicator} ${statusText}</div></div>`;
            }
            if (!currentSimulOpponent && Object.keys(simulGames).length > 0) autoSwitchSimulBoard();
        }

        // ================= ĐỒNG HỒ CỜ =================
        function formatTimeMs(ms) {
            if(ms <= 0) return "00:00";
            let totalSeconds = Math.floor(ms / 1000);
            let m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
            let s = (totalSeconds % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        }

        function updateSimulClockVisuals() {
            if (currentSystemMode !== 'simul') return;
            let game = null;
            if (myRole === 'student') game = mySimulGameData; else if (myRole === 'coach' && currentSimulOpponent) game = activeSimulGames[currentSimulOpponent];
            if (!game) return;

            let now = Date.now();
            let wTime = game.wTime; let bTime = game.bTime;
            let tColor = game.fen.split(' ')[1];

            if (game.status === 'playing') {
                let elapsed = now - game.lastMoveTimestamp;
                if (tColor === 'w') wTime -= elapsed; else bTime -= elapsed;
            }

            if (myRole === 'student') {
                let myColor = (mySimulCoachColor === 'w') ? 'b' : 'w';
                let coachT = (mySimulCoachColor === 'w') ? wTime : bTime; let myT = (myColor === 'w') ? wTime : bTime;
                document.getElementById('student-top-clock').innerText = formatTimeMs(coachT); document.getElementById('student-bottom-clock').innerText = formatTimeMs(myT);
                
                if(tColor === mySimulCoachColor) { document.getElementById('student-top-clock').classList.add('clock-active'); document.getElementById('student-bottom-clock').classList.remove('clock-active'); } 
                else { document.getElementById('student-top-clock').classList.remove('clock-active'); document.getElementById('student-bottom-clock').classList.add('clock-active'); }
            } else if (myRole === 'coach') {
                let studentColor = (mySimulCoachColor === 'w') ? 'b' : 'w';
                let coachT = (mySimulCoachColor === 'w') ? wTime : bTime; let studT = (studentColor === 'w') ? wTime : bTime;
                document.getElementById('coach-top-clock').innerText = formatTimeMs(studT); document.getElementById('coach-bottom-clock').innerText = formatTimeMs(coachT);
                
                if(tColor === studentColor) { document.getElementById('coach-top-clock').classList.add('clock-active'); document.getElementById('coach-bottom-clock').classList.remove('clock-active'); } 
                else { document.getElementById('coach-top-clock').classList.remove('clock-active'); document.getElementById('coach-bottom-clock').classList.add('clock-active'); }
            }
        }

        // ================= GIAO TIẾP VÀ KHỞI TẠO TỪ SERVER =================
        socket.on('init_game_state', (gameState) => {
            currentSystemMode = gameState.mode;
            if (gameState.roomId) {
                myRoomId = gameState.roomId;
                updateRoomBadgeUI(myRoomId);
            }
            if (gameState.coachName) {
                updateCoachNameInUI(gameState.coachName);
                if (myRole === 'coach') myName = gameState.coachName;
            }

            if (!hasJoinedRoom) {
                hasJoinedRoom = true;
                document.getElementById('login-screen').classList.add('hidden');
                document.getElementById('leaderboard-area').classList.remove('hidden');
                if (myRole === 'student') {
                    document.getElementById('student-screen').classList.remove('hidden');
                } else if (myRole === 'coach') {
                    document.getElementById('coach-screen').classList.remove('hidden');
                    if (gameState.mode === 'demo') {
                        const savedFen = gameState.fen || startFEN;
                        resetStudyTree(savedFen, { skipConfirm: true, skipServerSync: true });
                        coachArrows = gameState.arrows || [];
                        coachHighlights = gameState.highlights || [];
                        loadAndDrawFEN(savedFen, 'coach-board', true);
                        drawArrowsOnSvg('coach-arrows-svg', coachArrows);
                        renderBoardGraphics('coach-board', true);

                        if (!isStartingFen(savedFen)) {
                            setTimeout(() => {
                                if (confirm('Lớp đang giữ thế cờ từ buổi dạy trước.\n\nBạn có muốn reset về vị trí xuất phát (ván mới) để bắt đầu buổi học mới không?')) {
                                    resetStudyTree(startFEN);
                                }
                            }, 400);
                        }
                    }
                }
            } else if (myRole === 'coach' && gameState.mode === 'demo') {
                const savedFen = gameState.fen || startFEN;
                resetStudyTree(savedFen, { skipConfirm: true, skipServerSync: true });
                coachArrows = gameState.arrows || [];
                coachHighlights = gameState.highlights || [];
                loadAndDrawFEN(savedFen, 'coach-board', true);
                drawArrowsOnSvg('coach-arrows-svg', coachArrows);
                renderBoardGraphics('coach-board', true);
            }

            if (myRole === 'student' && !gameState.coachOnline && gameState.mode === 'demo') {
                document.getElementById('student-status').innerText = '⏳ Đang chờ thầy vào lớp...';
            }
            if (myRole === 'student') {
                if (gameState.mode === 'demo') {
                    if(gameState.fen) loadAndDrawFEN(gameState.fen, 'student-board', false); else loadAndDrawFEN(startFEN, 'student-board', false);
                    if(gameState.arrows) drawArrowsOnSvg('student-arrows-svg', gameState.arrows);
                    if(gameState.highlights) { coachHighlights = gameState.highlights; renderBoardGraphics('student-board', false); }
                    setStudentDemoUIMode();
                } else if (gameState.mode === 'quiz') {
                    if (gameState.timeLeft > 0) launchQuizInterface(gameState.currentQuiz, gameState.timeLeft);
                    else if (gameState.currentQuiz && gameState.currentQuiz.fen) {
                        loadAndDrawFEN(gameState.currentQuiz.fen, 'student-board', false);
                    }
                    if (gameState.quizReveal) showStudentQuizReveal(gameState.quizReveal);
                }
                else if (gameState.mode === 'simul') launchStudentSimulMode(gameState.mySimulGame);
            } else {
                if (gameState.mode === 'quiz') {
                    currentSystemMode = 'quiz';
                    document.getElementById('coach-demo-tools').classList.add('hidden');
                    document.getElementById('coach-stop-tools').classList.remove('hidden');
                    document.getElementById('btn-stop-quiz').classList.remove('hidden');
                    document.getElementById('btn-reveal-quiz').classList.remove('hidden');
                    document.getElementById('btn-coach-resign').classList.add('hidden');
                    document.getElementById('coach-mode-badge').innerText = "📝 TRẠNG THÁI: ĐANG KHẢO THÍ";
                    document.getElementById('coach-mode-badge').style.background = "#fffdf0";
                    document.getElementById('coach-mode-badge').style.color = "#e67e22";
                    if (gameState.currentQuiz?.fen) {
                        loadAndDrawFEN(gameState.currentQuiz.fen, 'coach-board', false);
                    }
                    if (gameState.timeLeft > 0) {
                        launchQuizInterface(gameState.currentQuiz, gameState.timeLeft);
                    } else if (gameState.quizReveal) {
                        showCoachQuizStats(gameState.quizReveal);
                        document.getElementById('timer-coach').innerText = 'Đã công bố đáp án';
                    }
                } else if (gameState.mode === 'simul') {
                    restoreSimulFromServer(gameState.simulGames, gameState.simulConfig);
                }
            }
        });

        socket.on('simul_started', (simulGames) => {
            currentSystemMode = 'simul';
            if (myRole === 'student') {
                if (simulGames[myName]) launchStudentSimulMode(simulGames[myName]);
            } else if (myRole === 'coach') renderCoachSimulDashboard(simulGames);
        });

        function showSimulEndStatus(game, resultText) {
            const label = resultText || getSimulStatusLabel(game) || 'Ván đấu đã kết thúc';
            document.getElementById('student-status').innerHTML = `<b style="color:#8e44ad;">${label}</b>`;
        }

        function launchStudentSimulMode(myGameData, resultText) {
            if (!myGameData) return;
            mySimulGameData = myGameData;
            document.getElementById('student-arrows-svg').innerHTML = '';
            document.getElementById('student-mode-badge').innerText = "⚔️ Chế độ: ĐANG ĐẤU CỜ VỚI THẦY";
            document.getElementById('student-mode-badge').style.background = "#f5eef8";
            document.getElementById('student-mode-badge').style.color = "#8e44ad";

            document.getElementById('timer').classList.add('hidden');
            document.getElementById('student-top-clock-bar').classList.remove('hidden');
            document.getElementById('student-bottom-clock-bar').classList.remove('hidden');
            document.getElementById('answers-area').classList.add('hidden');
            document.getElementById('student-text-answer-area').classList.add('hidden');
            document.getElementById('student-simul-title').classList.remove('hidden');

            mySimulCoachColor = myGameData.coachColor;
            let tColor = myGameData.fen.split(' ')[1];
            let isMyTurn = myGameData.status === 'playing' &&
                ((tColor === 'w' && mySimulCoachColor === 'b') || (tColor === 'b' && mySimulCoachColor === 'w'));

            loadAndDrawFEN(myGameData.fen, 'student-board', isMyTurn, myGameData.lastMoveFrom, myGameData.lastMoveTo);

            if (myGameData.status !== 'playing') {
                document.getElementById('btn-student-resign').classList.add('hidden');
                showSimulEndStatus(myGameData, resultText);
            } else {
                document.getElementById('btn-student-resign').classList.remove('hidden');
                if (isMyTurn) document.getElementById('student-status').innerHTML = "🟢 Tới lượt em! Hãy bốc cờ để tấn công...";
                else document.getElementById('student-status').innerHTML = `⏳ Đang đợi <b>${coachDisplayName}</b> qua bàn đi quân...`;
            }

            if (simulClockTickInterval) clearInterval(simulClockTickInterval);
            simulClockTickInterval = setInterval(updateSimulClockVisuals, 200);
        }

        socket.on('simul_update_coach_dashboard', (simulGames) => {
            if (myRole === 'coach') {
                renderCoachSimulDashboard(simulGames);
                if (currentSimulOpponent) {
                    let g = simulGames[currentSimulOpponent];
                    let tColor = g.fen.split(' ')[1];
                    if (tColor !== g.coachColor) autoSwitchSimulBoard();
                }
            }
        });

        socket.on('simul_update_game', (data) => {
            if (myRole === 'student' && myName === data.student) {
                mySimulGameData = data.game;
                launchStudentSimulMode(data.game, data.resultText);
            } else if (myRole === 'coach') {
                activeSimulGames[data.student] = data.game;
                if (currentSimulOpponent === data.student) {
                    loadSimulGameOnCoachBoard(data.student);
                    if (data.resultText) {
                        const logs = document.getElementById('coach-logs');
                        if (!logs.classList.contains('hidden')) {
                            logs.innerHTML += `<p style="margin:6px 0; color:#8e44ad;"><b>${data.student}</b>: ${data.resultText}</p>`;
                        }
                    }
                }
            }
        });

        socket.on('sync_demo_board', (data) => {
            if (myRole === 'student' && currentSystemMode === 'demo') {
                loadAndDrawFEN(data.fen, 'student-board', false, data.lastMoveFrom, data.lastMoveTo);
            }
        });

        socket.on('demo_board_reset', (data) => {
            if (currentSystemMode !== 'demo') return;
            const fen = data.fen || startFEN;
            if (myRole === 'student') {
                coachArrows = data.arrows || [];
                coachHighlights = data.highlights || [];
                loadAndDrawFEN(fen, 'student-board', false);
                drawArrowsOnSvg('student-arrows-svg', coachArrows);
                renderBoardGraphics('student-board', false);
            } else if (myRole === 'coach') {
                resetStudyTree(fen, { skipConfirm: true, skipServerSync: true });
            }
        });
        socket.on('update_student_arrows', (arrows) => { if (myRole === 'student' && currentSystemMode === 'demo') drawArrowsOnSvg('student-arrows-svg', arrows); });
        socket.on('update_student_highlights', (hl) => { if (myRole === 'student' && currentSystemMode === 'demo') { coachHighlights = hl; renderBoardGraphics('student-board', false); }});

        // ================= CÁC HÀM XỬ LÝ KHẢO THÍ VÀ CHUNG =================
        function sendQuestion() {
            document.getElementById('coach-demo-tools').classList.add('hidden');
            document.getElementById('coach-stop-tools').classList.remove('hidden');
            document.getElementById('btn-stop-quiz').classList.remove('hidden');
            document.getElementById('btn-reveal-quiz').classList.remove('hidden');
            document.getElementById('btn-coach-resign').classList.add('hidden');
            const type = document.getElementById('input-type').value; 
            let correctAnswer = document.getElementById(type === 'quiz' ? 'input-correct-quiz' : 'input-correct-move').value.trim();
            if (!correctAnswer) { alert("Vui lòng gõ đáp án chuẩn vào ô trống!"); return; }
            socket.emit('send_question', { type: type, fen: chessEngine.fen(), a: document.getElementById('input-a').value, b: document.getElementById('input-b').value, c: document.getElementById('input-c').value, d: document.getElementById('input-d').value, correctAnswer: correctAnswer, seconds: document.getElementById('input-seconds').value });
        }

        function stopModesAndBackToDemo() { socket.emit('stop_quiz_mode'); }
        socket.on('new_question', (data) => { launchQuizInterface(data, data.seconds); });

        socket.on('switch_to_demo_mode', (data) => {
            if (countdownInterval) clearInterval(countdownInterval); if(simulClockTickInterval) clearInterval(simulClockTickInterval);
            currentSystemMode = 'demo'; selectedSquare = null; currentRecordedMove = '';
            
            if (myRole === 'student') {
                setStudentDemoUIMode();
                if (data.fen) loadAndDrawFEN(data.fen, 'student-board', false);
                coachHighlights = data.highlights || []; renderBoardGraphics('student-board', false);
                drawArrowsOnSvg('student-arrows-svg', data.arrows || []);
            } else {
                document.getElementById('coach-quiz-stats').classList.add('hidden');
                document.getElementById('btn-reveal-quiz').classList.add('hidden');
                document.getElementById('btn-coach-resign').classList.add('hidden');
                document.getElementById('btn-student-resign').classList.add('hidden');
                document.getElementById('coach-mode-badge').innerText = "📺 TRẠNG THÁI: ĐANG TRÌNH DIỄN BÀI GIẢNG"; document.getElementById('coach-mode-badge').style.background = "#e8f8f5"; document.getElementById('coach-mode-badge').style.color = "#27ae60";
                document.getElementById('coach-demo-tools').classList.remove('hidden'); document.getElementById('coach-stop-tools').classList.add('hidden'); document.getElementById('btn-stop-quiz').classList.add('hidden'); document.getElementById('btn-stop-simul').classList.add('hidden');
                document.getElementById('timer-coach').classList.remove('hidden'); document.getElementById('coach-top-clock-bar').classList.add('hidden'); document.getElementById('coach-bottom-clock-bar').classList.add('hidden');
                document.getElementById('panel-title-logs').innerText = "Nhật ký hệ thống:"; document.getElementById('coach-logs').classList.remove('hidden'); document.getElementById('coach-simul-dashboard').classList.add('hidden'); document.getElementById('coach-simul-header').classList.add('hidden');
                currentSimulOpponent = null;
                
                const setupMode = document.getElementById('board-setup-mode').value;
                if (setupMode === 'starting') {
                    resetStudyTree(data?.fen || chessEngine.fen() || startFEN, { skipConfirm: true, skipServerSync: true });
                } else {
                    const fen = document.getElementById('input-fen').value.trim() || startFEN;
                    resetStudyTree(fen, { skipConfirm: true, skipServerSync: true });
                }
                drawArrowsOnSvg('coach-arrows-svg', coachArrows);
            }
        });

        function setStudentDemoUIMode() {
            document.getElementById('student-mode-badge').innerText = "📺 Chế độ: Thầy giảng bài (Khóa bàn cờ)";
            document.getElementById('student-mode-badge').style.background = "#e8f4f8";
            document.getElementById('student-mode-badge').style.color = "#2980b9";
            document.getElementById('answers-area').classList.add('hidden');
            document.getElementById('student-text-answer-area').classList.add('hidden');
            document.getElementById('student-simul-title').classList.add('hidden');
            document.getElementById('student-quiz-result').classList.add('hidden');
            document.getElementById('btn-student-resign').classList.add('hidden');
            document.getElementById('timer').classList.remove('hidden'); document.getElementById('student-top-clock-bar').classList.add('hidden'); document.getElementById('student-bottom-clock-bar').classList.add('hidden');
            document.getElementById('student-status').innerText = `Đang đồng bộ bàn cờ trực tiếp với bài giảng của ${coachDisplayName}...`; document.getElementById('timer').innerText = "00:00";
        }

        function showStudentQuizReveal(data) {
            const panel = document.getElementById('student-quiz-result');
            panel.classList.remove('hidden');
            const sub = lastStudentQuizSubmission;
            let resultHtml = '';
            if (sub) {
                panel.classList.toggle('wrong', !sub.isCorrect);
                const icon = sub.isCorrect ? '✅' : '❌';
                const norm = sub.normalizedAnswer ? ` (${sub.normalizedAnswer})` : '';
                resultHtml = `<p>${icon} Em trả lời: <b>${sub.answer}</b>${norm} — <b>${sub.isCorrect ? 'ĐÚNG' : 'SAI'}</b></p>`;
            } else {
                panel.classList.add('wrong');
                resultHtml = '<p>⏱️ Em không kịp nộp bài.</p>';
            }
            const ansLabel = data.type === 'text' && data.displayAnswer ? data.displayAnswer : data.correctAnswer;
            resultHtml += `<p>📌 Đáp án đúng: <b style="color:#27ae60;">${ansLabel}</b></p>`;
            resultHtml += `<p style="font-size:13px; color:#7f8c8d;">Lớp: ${data.stats.correct}/${data.stats.submitted} đúng (${data.stats.percentage}%)</p>`;
            panel.innerHTML = resultHtml;
            document.getElementById('student-status').innerText = 'Thầy đã công bố đáp án!';
            document.getElementById('timer').innerText = 'Hết giờ';
        }

        function showCoachQuizStats(data) {
            const panel = document.getElementById('coach-quiz-stats');
            panel.classList.remove('hidden');
            const ansLabel = data.type === 'text' && data.displayAnswer ? data.displayAnswer : data.correctAnswer;
            let html = `<h4 style="margin:0 0 8px; color:#e67e22;">📊 Kết quả câu hỏi</h4>`;
            html += `<p><b>Đáp án đúng:</b> ${ansLabel}</p>`;
            html += `<p><b>${data.stats.correct}/${data.stats.submitted}</b> học trò đúng (${data.stats.percentage}%) — ${data.stats.submitted}/${data.stats.total} đã nộp</p>`;
            if (data.submissions.length) {
                html += '<ul style="margin:8px 0; padding-left:18px; font-size:14px;">';
                data.submissions.forEach((s) => {
                    const norm = s.normalizedAnswer ? ` → ${s.normalizedAnswer}` : '';
                    html += `<li><b>${s.name}</b>: ${s.answer}${norm} — ${s.isCorrect ? '✅' : '❌'} (${s.timeSpent}s)</li>`;
                });
                html += '</ul>';
            }
            panel.innerHTML = html;
        }

        function launchQuizInterface(data, secondsLeft) {
            if (countdownInterval) clearInterval(countdownInterval);
            let timeLeft = secondsLeft;
            currentSystemMode = 'quiz';
            lastStudentQuizSubmission = null;
            if (myRole === 'coach') document.getElementById('coach-quiz-stats').classList.add('hidden');
            if (myRole === 'student') document.getElementById('student-quiz-result').classList.add('hidden');
            if (myRole === 'student') {
                document.getElementById('student-arrows-svg').innerHTML = ''; document.getElementById('student-typed-input').value = ''; document.getElementById('student-simul-title').classList.add('hidden');
                document.getElementById('student-mode-badge').innerText = "📝 Chế độ: ĐANG LÀM BÀI KIỂM TRA"; document.getElementById('student-mode-badge').style.background = "#fffdf0"; document.getElementById('student-mode-badge').style.color = "#e67e22";
                if (data.type === 'quiz') {
                    loadAndDrawFEN(data.fen, 'student-board', false); document.getElementById('text-a').innerText = data.a; document.getElementById('text-b').innerText = data.b; document.getElementById('text-c').innerText = data.c; document.getElementById('text-d').innerText = data.d;
                    document.getElementById('answers-area').classList.remove('hidden'); document.getElementById('student-text-answer-area').classList.add('hidden'); document.getElementById('student-status').innerText = "Thầy ra đề TRẮC NGHIỆM! Hãy chọn đáp án đúng:";
                } else {
                    loadAndDrawFEN(data.fen, 'student-board', false); document.getElementById('answers-area').classList.add('hidden'); document.getElementById('student-text-answer-area').classList.remove('hidden'); document.getElementById('student-status').innerText = "Thầy ra đề TỰ LUẬN! Hãy nhìn bàn cờ và gõ câu trả lời của em vào ô dưới đây:";
                }
            }
            countdownInterval = setInterval(() => {
                let displayStr = `Còn lại: ${timeLeft} Giây`;
                if (myRole === 'student') document.getElementById('timer').innerText = displayStr; else document.getElementById('timer-coach').innerText = displayStr;
                timeLeft--;
                if (timeLeft < 0) {
                    clearInterval(countdownInterval);
                    if (myRole === 'student') {
                        document.getElementById('answers-area').classList.add('hidden');
                        document.getElementById('student-text-answer-area').classList.add('hidden');
                        document.getElementById('student-status').innerText = "⏱️ Hết giờ! Đang chờ công bố đáp án...";
                        document.getElementById('timer').innerText = "00:00";
                    } else document.getElementById('timer-coach').innerText = "Hết giờ!";
                }
            }, 1000);
        }

        function submitQuizAnswer(option) {
            document.getElementById('answers-area').classList.add('hidden');
            document.getElementById('student-status').innerHTML = `🚀 Đã nộp đáp án: <span style="color:#007bff; font-weight:bold;">Câu ${option}</span>. Chờ công bố đáp án...`;
            lastStudentQuizSubmission = { answer: option, isCorrect: null };
            socket.emit('submit_answer', option);
        }
        function confirmStudentTypedAnswer() {
            let typedAns = document.getElementById('student-typed-input').value.trim();
            if (!typedAns) { alert("Em vui lòng gõ câu trả lời vào ô trống trước khi nộp bài!"); return; }
            document.getElementById('student-text-answer-area').classList.add('hidden');
            document.getElementById('student-status').innerHTML = `🚀 Đã nộp đáp án: [<b>${typedAns}</b>]. Chờ công bố đáp án...`;
            lastStudentQuizSubmission = { answer: typedAns, isCorrect: null };
            socket.emit('submit_answer', typedAns);
        }

        socket.on('student_quiz_result', (sub) => {
            lastStudentQuizSubmission = sub;
        });

        socket.on('quiz_revealed', (data) => {
            if (countdownInterval) clearInterval(countdownInterval);
            document.getElementById('answers-area').classList.add('hidden');
            document.getElementById('student-text-answer-area').classList.add('hidden');
            if (myRole === 'student') {
                if (!lastStudentQuizSubmission || lastStudentQuizSubmission.isCorrect === null) {
                    const mine = (data.submissions || []).find((s) => s.name === myName);
                    if (mine) lastStudentQuizSubmission = mine;
                }
                showStudentQuizReveal(data);
            } else {
                showCoachQuizStats(data);
                document.getElementById('timer-coach').innerText = 'Đã công bố đáp án';
            }
        });

        document.getElementById('student-typed-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmStudentTypedAnswer();
        });

        socket.on('coach_name_updated', (name) => updateCoachNameInUI(name));
        
        socket.on('student_already_submitted', () => { if (myRole === 'student') { document.getElementById('answers-area').classList.add('hidden'); document.getElementById('student-text-answer-area').classList.add('hidden'); document.getElementById('student-status').innerText = "🛑 Em đã nộp bài rồi! Ngồi đợi thầy chữa bài nhé."; }});
        socket.on('coach_receive', (data) => {
            if (myRole === 'coach') {
                const logs = document.getElementById('coach-logs');
                const statusSymbol = data.isCorrect ? "✅ ĐÚNG" : "❌ SAI";
                const norm = data.normalizedAnswer ? ` <span style="color:#7f8c8d;">(→ ${escapeHtml(data.normalizedAnswer)})</span>` : '';
                logs.innerHTML += `<p style="margin:6px 0;">• Học trò <b>${escapeHtml(data.name)}</b> trả lời: [${escapeHtml(data.answer)}]${norm} -> <span style="color:${data.isCorrect ? '#27ae60' : '#c0392b'}; font-weight:bold;">${statusSymbol}</span> <span style="color:#7f8c8d; font-size:13px;">(sau ${data.timeSpent} s)</span></p>`;
                logs.scrollTop = logs.scrollHeight;
            }
        });
        
        function resetLeaderboard() { if(confirm("Xác nhận đưa điểm số cả lớp về lại 0?")) socket.emit('reset_scores'); }
        
        socket.on('update_leaderboard', (leaderboard) => {
            const tbody = document.getElementById('leaderboard-body'); tbody.innerHTML = '';
            let sortedArr = Object.entries(leaderboard).sort((a, b) => { if (b[1].points !== a[1].points) return b[1].points - a[1].points; return a[1].totalTime - b[1].totalTime; });
            sortedArr.forEach((item, index) => {
                const name = escapeHtml(item[0]);
                tbody.innerHTML += `<tr ${index === 0 ? 'class="rank-1"' : ''}><td>Hạng ${index + 1}</td><td><b>${name}</b></td><td><span style="background:#e8f8f5; padding:4px 10px; border-radius:15px; font-weight:bold; color:#117a65;">${item[1].points} Pts</span></td><td><span style="background:#fef9e7; padding:4px 10px; border-radius:15px; font-weight:bold; color:#b7950b;">${item[1].totalTime} s</span></td></tr>`;
            });
        });

        Object.assign(window, {
            joinRoom,
            copyRoomLink,
            studyFirst,
            studyBack,
            studyForward,
            studyLast,
            uploadPgnFile,
            downloadPgn,
            resetStudyTree,
            handleBoardSetupModeChange,
            clearCoachMarkings,
            startSimulMode,
            sendQuestion,
            stopModesAndBackToDemo,
            revealQuizNow,
            coachResignSimul,
            resetLeaderboard,
            submitQuizAnswer,
            confirmStudentTypedAnswer,
            resignSimul,
            toggleCoachInputs,
        });
