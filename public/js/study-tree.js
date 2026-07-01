/**
 * Cây nước đi kiểu Lichess Study — hỗ trợ nhánh, điều hướng, import/export PGN.
 * Dùng chung chess.js (global Chess) với client.
 */
(function (global) {
    const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    function createNode(san, fen, parent) {
        return { san, fen, children: [], parent: parent || null };
    }

    function tryMove(chess, token) {
        const t = token.replace(/[+#]+$/, '');
        try {
            const m = chess.move(t);
            if (m) return m;
        } catch (e) { /* ignore */ }
        chess.load(chess.fen());
        const uci = t.replace(/[-\s]/g, '').match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
        if (uci) {
            const opts = { from: uci[1], to: uci[2] };
            if (uci[3]) opts.promotion = uci[3].toLowerCase();
            try {
                return chess.move(opts);
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function tokenizeMovetext(movetext) {
        const clean = movetext
            .replace(/\{[^}]*\}/g, ' ')
            .replace(/\$\d+/g, ' ')
            .replace(/;[^\n]*/g, ' ')
            .replace(/\r/g, ' ');
        const tokens = [];
        const re = /\(|\)|\d+\.\.\.|\d+\.|O-O-O|O-O|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|--/gi;
        let m;
        while ((m = re.exec(clean)) !== null) {
            if (m[0]) tokens.push(m[0]);
        }
        return tokens;
    }

    function buildFromTokens(tokens, startIndex, attachParent, fen) {
        const chess = new Chess(fen);
        let current = attachParent;
        let i = startIndex;

        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok === ')') return i + 1;
            if (tok === '(') {
                const branchParent = current.parent || current;
                i++;
                i = buildFromTokens(tokens, i, branchParent, branchParent.fen);
                continue;
            }
            if (/^\d+\.+$/.test(tok) || tok === '...') {
                i++;
                continue;
            }

            const move = tryMove(chess, tok);
            if (!move) {
                i++;
                continue;
            }

            const existing = current.children.find((c) => c.san === move.san);
            if (existing) {
                current = existing;
                chess.load(existing.fen);
            } else {
                const child = createNode(move.san, chess.fen(), current);
                current.children.push(child);
                current = child;
            }
            i++;
        }
        return i;
    }

    function extractHeadersAndMovetext(pgnText) {
        const headers = {};
        const lines = pgnText.replace(/\r/g, '').split('\n');
        const movetextLines = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const headerMatch = trimmed.match(/^\[(\w+)\s+"(.*)"\]\s*$/);
            if (headerMatch) {
                headers[headerMatch[1]] = headerMatch[2];
                continue;
            }
            movetextLines.push(trimmed);
        }
        return { headers, movetext: movetextLines.join(' ') };
    }

    function buildMovetextRecursive(node, moveIndex, isWhite) {
        let parts = [];
        let idx = moveIndex;
        let white = isWhite;

        for (let ci = 0; ci < node.children.length; ci++) {
            const child = node.children[ci];
            if (ci > 0) {
                parts.push('(');
                if (!white) parts.push(Math.ceil(idx) + '...');
            }
            if (white) {
                parts.push(Math.floor(idx) + '.');
                parts.push(child.san);
                idx += 0.5;
                white = false;
            } else {
                parts.push(child.san);
                idx += 0.5;
                white = true;
            }
            const sub = buildMovetextRecursive(child, idx, white);
            parts.push(sub.text);
            idx = sub.moveIndex;
            white = sub.isWhite;
            if (ci > 0) parts.push(')');
        }
        return { text: parts.join(' '), moveIndex: idx, isWhite: white };
    }

    class StudyTree {
        constructor(startFen) {
            this.startFen = startFen || DEFAULT_FEN;
            this.headers = {
                Event: 'Bài giảng cờ vua',
                Site: 'Chess Grand Prix',
                Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
            };
            this.root = createNode(null, this.startFen, null);
            this.current = this.root;
        }

        reset(fen) {
            this.startFen = fen || DEFAULT_FEN;
            this.root = createNode(null, this.startFen, null);
            this.current = this.root;
        }

        getCurrentFen() {
            return this.current.fen;
        }

        findChildBySan(san) {
            return this.current.children.find((c) => c.san === san) || null;
        }

        /** Thêm nước đi từ vị trí hiện tại; nếu nhánh đã tồn tại thì nhảy tới đó. */
        addMove(san, fen) {
            const existing = this.findChildBySan(san);
            if (existing) {
                this.current = existing;
                return existing;
            }
            const child = createNode(san, fen, this.current);
            this.current.children.push(child);
            this.current = child;
            return child;
        }

        goTo(node) {
            if (!node) return;
            this.current = node;
        }

        goToParent() {
            if (this.current.parent) this.current = this.current.parent;
        }

        goToChild(index) {
            const idx = index || 0;
            if (this.current.children[idx]) this.current = this.current.children[idx];
        }

        goToRoot() {
            this.current = this.root;
        }

        goToEnd(mainLineOnly) {
            while (this.current.children.length > 0) {
                this.current = this.current.children[0];
            }
        }

        /** Đi tới node theo đường đi (mảng chỉ số nhánh). */
        goToPath(path) {
            let node = this.root;
            for (const branchIdx of path) {
                if (!node.children[branchIdx]) return;
                node = node.children[branchIdx];
            }
            this.current = node;
        }

        loadFromPgn(pgnText) {
            const { headers, movetext } = extractHeadersAndMovetext(pgnText);
            if (headers.FEN) this.startFen = headers.FEN;
            else if (headers.SetUp === '1' && headers.FEN) this.startFen = headers.FEN;
            this.headers = { ...this.headers, ...headers };

            this.root = createNode(null, this.startFen, null);
            const tokens = tokenizeMovetext(movetext);
            if (tokens.length > 0) {
                buildFromTokens(tokens, 0, this.root, this.startFen);
            }
            this.current = this.root;
        }

        exportPgn() {
            const headerLines = Object.entries(this.headers).map(
                ([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`
            );
            if (!this.headers.FEN && this.startFen !== DEFAULT_FEN) {
                headerLines.push(`[FEN "${this.startFen}"]`);
                headerLines.push('[SetUp "1"]');
            }
            const movetext = buildMovetextRecursive(this.root, 1, true).text.trim();
            return headerLines.join('\n') + '\n\n' + (movetext || '*') + '\n';
        }

        /** Kiểm tra node có nằm trên đường từ root tới current không. */
        isOnCurrentPath(node) {
            let n = this.current;
            while (n) {
                if (n === node) return true;
                n = n.parent;
            }
            return false;
        }
    }

    global.StudyTree = StudyTree;
    global.DEFAULT_START_FEN = DEFAULT_FEN;
})(typeof window !== 'undefined' ? window : global);
