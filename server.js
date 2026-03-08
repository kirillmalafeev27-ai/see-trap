const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

const PHASE = {
  SETUP_WORDS: "setup_words",
  SETUP_MARKER: "setup_marker",
  PLAYER_MOVE: "player_move",
  PLAYER_BLOCK: "player_block",
  AWAIT_SENTENCE: "await_sentence",
  COMPUTER_TURN: "computer_turn",
  GAME_OVER: "game_over"
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.redirect("/student.html"));
app.get("/student", (_req, res) => res.redirect("/student.html"));
app.get("/teacher", (_req, res) => res.redirect("/teacher.html"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

function createMatrix(size, value) {
  return Array.from({ length: size }, () => Array(size).fill(value));
}

function makeState(size = 7) {
  return {
    size,
    phase: PHASE.SETUP_WORDS,
    currentTurn: "player",
    wordPool: [],
    boardWordIds: createMatrix(size, null),
    blocked: createMatrix(size, false),
    marker: { r: Math.floor(size / 2), c: Math.floor(size / 2) },
    markerWord: "",
    nextMarkerWord: "",
    lastPathWords: [],
    requiredWords: [],
    sentenceText: "",
    sentenceSubmitted: false,
    feedback: "",
    info: "Ожидание загрузки слов.",
    aiThinking: false,
    gameOver: false,
    winner: ""
  };
}

let state = makeState(7);
let busyComputerTurn = false;

function inBounds(size, r, c) {
  return r >= 0 && c >= 0 && r < size && c < size;
}

function getWordById(id) {
  return state.wordPool.find((w) => w.id === id) || null;
}

function getWordAt(r, c) {
  const id = state.boardWordIds[r][c];
  if (id == null) return "";
  const item = getWordById(id);
  return item ? item.word : "";
}

function boardAssignedCount() {
  let count = 0;
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (state.boardWordIds[r][c] != null) count += 1;
    }
  }
  return count;
}

function allBoardCellsAssigned() {
  return boardAssignedCount() === state.size * state.size;
}

function recomputeUsedFlags() {
  const usedIds = new Set();
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      const id = state.boardWordIds[r][c];
      if (id != null) usedIds.add(id);
    }
  }
  for (const item of state.wordPool) {
    item.used = usedIds.has(item.id);
  }
}

function getPathCells(from, to) {
  const result = [];
  if (from.r === to.r) {
    const step = to.c > from.c ? 1 : -1;
    for (let c = from.c + step; c !== to.c + step; c += step) {
      result.push({ r: from.r, c });
    }
  } else if (from.c === to.c) {
    const step = to.r > from.r ? 1 : -1;
    for (let r = from.r + step; r !== to.r + step; r += step) {
      result.push({ r, c: from.c });
    }
  }
  return result;
}

function getLegalMoves(markerRef, blockedRef) {
  const marker = markerRef || state.marker;
  const blocked = blockedRef || state.blocked;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  const out = [];

  for (const [dr, dc] of dirs) {
    let r = marker.r + dr;
    let c = marker.c + dc;
    while (inBounds(state.size, r, c) && !blocked[r][c]) {
      out.push({ r, c });
      r += dr;
      c += dc;
    }
  }
  return out;
}

function getLegalBlocks(markerRef, blockedRef) {
  const marker = markerRef || state.marker;
  const blocked = blockedRef || state.blocked;
  const out = [];

  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (!blocked[r][c] && !(marker.r === r && marker.c === c)) {
        out.push({ r, c });
      }
    }
  }
  return out;
}

function hasAnyMove() {
  return getLegalMoves().length > 0;
}

function evaluatePressure(pos, blocked) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  let walls = 0;
  for (const [dr, dc] of dirs) {
    const nr = pos.r + dr;
    const nc = pos.c + dc;
    if (!inBounds(state.size, nr, nc) || blocked[nr][nc]) walls += 1;
  }
  return walls;
}

function chooseComputerAction() {
  const moves = getLegalMoves(state.marker, state.blocked);
  if (moves.length === 0) return null;

  let bestScore = -Infinity;
  let best = [];

  for (const move of moves) {
    const blocks = getLegalBlocks(move, state.blocked);
    for (const block of blocks) {
      const sim = state.blocked.map((row) => row.slice());
      sim[block.r][block.c] = true;
      const nextMoves = getLegalMoves(move, sim).length;
      const score = -nextMoves * 100 + evaluatePressure(move, sim) * 8 + Math.random() * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = [{ move, block }];
      } else if (score === bestScore) {
        best.push({ move, block });
      }
    }
  }

  return best[Math.floor(Math.random() * best.length)] || null;
}

function parseGermanWord(lineRaw) {
  let line = String(lineRaw || "").trim();
  if (!line) return "";

  const pairMatch = line.match(/^(.*?)(?:\s[-–—:|]\s|\t)(.+)$/);
  if (pairMatch) {
    line = pairMatch[1].trim();
  } else {
    const cyr = line.search(/[А-Яа-яЁё]/);
    if (cyr > 0) line = line.slice(0, cyr).trim();
  }

  line = line.replace(/[.,;:]+$/g, "").trim();
  return line;
}

function parseWordContainer(raw) {
  const text = String(raw || "");
  let lines = text
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    lines = text
      .split(/[;,]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return lines
    .map(parseGermanWord)
    .map((s) => s.trim())
    .filter(Boolean);
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function payloadState() {
  return {
    ...state,
    boardWords: state.boardWordIds.map((row, r) => row.map((id, c) => {
      if (id == null) return "";
      return getWordAt(r, c);
    }))
  };
}

function emitState(extra = {}) {
  io.emit("state:update", {
    state: payloadState(),
    ...extra
  });
}

function sendError(socket, message) {
  socket.emit("action:error", { message });
}

function sendInfo(socket, message) {
  socket.emit("action:info", { message });
}

function setSize(size) {
  state = makeState(size);
}

function softResetBoard() {
  state.boardWordIds = createMatrix(state.size, null);
  state.blocked = createMatrix(state.size, false);
  state.marker = { r: Math.floor(state.size / 2), c: Math.floor(state.size / 2) };
  state.phase = PHASE.SETUP_WORDS;
  state.currentTurn = "player";
  state.markerWord = "";
  state.nextMarkerWord = "";
  state.lastPathWords = [];
  state.requiredWords = [];
  state.sentenceText = "";
  state.sentenceSubmitted = false;
  state.feedback = "";
  state.info = "Подготовка поля.";
  state.aiThinking = false;
  state.gameOver = false;
  state.winner = "";
  for (const item of state.wordPool) item.used = false;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getMarkerCandidateWords() {
  const words = new Set();
  const legal = getLegalMoves();
  for (const to of legal) {
    const path = getPathCells(state.marker, to);
    for (const cell of path) {
      const word = getWordAt(cell.r, cell.c);
      if (word) words.add(word);
    }
  }
  if (words.size === 0) {
    for (const item of state.wordPool) words.add(item.word);
  }
  const list = [...words].filter((w) => w !== state.markerWord);
  return list;
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY не задан на сервере.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini вернул пустой ответ.");
  return text;
}

async function pickNextMarkerWordByAI() {
  const candidates = getMarkerCandidateWords();
  if (candidates.length === 0) return "";

  let chosen = candidates[Math.floor(candidates.length / 2)];
  try {
    const prompt = [
      "Выбери одно слово для маркера в учебной игре немецкого.",
      "Верни только одно слово из списка, без объяснений.",
      `Список: ${candidates.join(", ")}`,
      `Текущее слово маркера: ${state.markerWord}`
    ].join("\n");

    const text = await callGemini(prompt);
    const normalized = text.replace(/["'`]/g, "").trim();
    const exact = candidates.find((w) => w.toLowerCase() === normalized.toLowerCase());
    if (exact) chosen = exact;
  } catch (_err) {
    // fallback already set
  }
  return chosen;
}

function checkWordOrderLocal(requiredWords, sentence) {
  const s = String(sentence || "").toLowerCase();
  let idx = -1;
  for (const word of requiredWords) {
    const p = s.indexOf(String(word).toLowerCase(), idx + 1);
    if (p < 0) return false;
    idx = p;
  }
  return true;
}

async function runComputerTurn() {
  if (busyComputerTurn) return;
  busyComputerTurn = true;

  try {
    state.phase = PHASE.COMPUTER_TURN;
    state.currentTurn = "computer";
    state.aiThinking = true;
    state.info = "Ход компьютера.";
    emitState();

    await sleep(400);

    if (!hasAnyMove()) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "player";
      state.aiThinking = false;
      state.info = "Компьютеру некуда ходить.";
      emitState();
      return;
    }

    const action = chooseComputerAction();
    if (!action) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "player";
      state.aiThinking = false;
      state.info = "Компьютер не нашел ход.";
      emitState();
      return;
    }

    const from = { ...state.marker };
    state.marker = { ...action.move };
    emitState({ animation: { type: "move", actor: "computer", from, to: action.move } });

    await sleep(480);

    state.blocked[action.block.r][action.block.c] = true;
    emitState({ animation: { type: "block", actor: "computer", cell: action.block } });

    await sleep(480);

    state.aiThinking = false;
    state.phase = PHASE.PLAYER_MOVE;
    state.currentTurn = "player";
    state.requiredWords = [];
    state.lastPathWords = [];
    state.sentenceText = "";
    state.sentenceSubmitted = false;
    state.feedback = "";
    state.info = "Ход игрока.";

    if (!hasAnyMove()) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "computer";
      state.info = "Игроку некуда ходить.";
    }

    emitState();
  } finally {
    busyComputerTurn = false;
  }
}

function canPlayAsPlayer(socket) {
  return socket.data.role === "student" || socket.data.role === "teacher";
}

io.on("connection", (socket) => {
  const roleRaw = socket.handshake.auth?.role || socket.handshake.query?.role || "student";
  const role = roleRaw === "teacher" ? "teacher" : "student";
  socket.data.role = role;
  socket.emit("session:role", { role });
  socket.emit("state:update", { state: payloadState() });

  socket.on("teacher:setSize", ({ size }) => {
    if (socket.data.role !== "teacher") return;
    const n = Number(size);
    if (![5, 6, 7].includes(n)) {
      sendError(socket, "Допустимые размеры: 5, 6, 7.");
      return;
    }
    setSize(n);
    state.info = `Размер поля изменен: ${n}x${n}`;
    emitState();
  });

  socket.on("teacher:loadWords", ({ raw }) => {
    if (socket.data.role !== "teacher") return;
    const words = parseWordContainer(raw);
    const needed = state.size * state.size;
    if (words.length !== needed) {
      sendError(socket, `Нужно ровно ${needed} слов. Сейчас: ${words.length}.`);
      return;
    }

    state.wordPool = words.map((word, idx) => ({ id: idx + 1, word, used: false }));
    softResetBoard();
    state.info = `Загружено ${needed} слов.`;
    emitState();
  });

  socket.on("teacher:shuffleBoardWords", () => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.SETUP_WORDS) {
      sendError(socket, "Перемешивание поля доступно только на этапе заполнения слов.");
      return;
    }
    if (!allBoardCellsAssigned()) {
      sendError(socket, "Сначала заполните все клетки поля словами.");
      return;
    }

    const ids = [];
    for (let r = 0; r < state.size; r += 1) {
      for (let c = 0; c < state.size; c += 1) ids.push(state.boardWordIds[r][c]);
    }
    const shuffled = shuffleArray(ids);
    let k = 0;
    for (let r = 0; r < state.size; r += 1) {
      for (let c = 0; c < state.size; c += 1) {
        state.boardWordIds[r][c] = shuffled[k++];
      }
    }
    recomputeUsedFlags();
    state.info = "Слова на поле перемешаны.";
    emitState();
  });

  socket.on("teacher:finishWordPlacement", () => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.SETUP_WORDS) return;
    if (!allBoardCellsAssigned()) {
      sendError(socket, `Заполнено ${boardAssignedCount()} из ${state.size * state.size} клеток.`);
      return;
    }
    state.phase = PHASE.SETUP_MARKER;
    state.info = "Выберите стартовое слово маркера.";
    emitState();
  });

  socket.on("teacher:setInitialMarkerWord", ({ wordId }) => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.SETUP_MARKER) return;

    const item = getWordById(Number(wordId));
    if (!item) {
      sendError(socket, "Слово не найдено.");
      return;
    }

    state.markerWord = item.word;
    state.nextMarkerWord = "";
    state.phase = PHASE.PLAYER_MOVE;
    state.currentTurn = "player";
    state.feedback = "";
    state.info = "Ход игрока.";

    if (!hasAnyMove()) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "computer";
      state.info = "Игроку некуда ходить.";
    }

    emitState();
  });

  socket.on("teacher:setNextMarkerWord", ({ wordId }) => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Следующее слово маркера выбирается после хода игрока.");
      return;
    }

    const item = getWordById(Number(wordId));
    if (!item) {
      sendError(socket, "Слово не найдено.");
      return;
    }
    if (item.word === state.markerWord) {
      sendError(socket, "Нужно выбрать другое слово, не текущее.");
      return;
    }

    state.nextMarkerWord = item.word;
    state.info = `Следующее слово маркера: ${item.word}`;
    emitState();
  });

  socket.on("teacher:generateNextMarkerWord", async () => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Генерация доступна после хода игрока.");
      return;
    }

    const chosen = await pickNextMarkerWordByAI();
    if (!chosen) {
      sendError(socket, "Нет доступных кандидатов для слова маркера.");
      return;
    }

    state.nextMarkerWord = chosen;
    state.info = `AI выбрал следующее слово маркера: ${chosen}`;
    emitState();
  });

  socket.on("game:cellClick", async ({ r, c, wordId }) => {
    const row = Number(r);
    const col = Number(c);
    if (!inBounds(state.size, row, col)) return;

    if (state.phase === PHASE.SETUP_WORDS) {
      if (socket.data.role !== "teacher") return;
      const selectedId = Number(wordId);
      const item = getWordById(selectedId);
      if (!item) {
        sendError(socket, "Слово для заполнения не выбрано.");
        return;
      }

      const current = state.boardWordIds[row][col];
      if (item.used && current !== selectedId) {
        sendError(socket, "Это слово уже размещено в другой клетке.");
        return;
      }

      if (current != null && current !== selectedId) {
        const prev = getWordById(current);
        if (prev) prev.used = false;
      }

      state.boardWordIds[row][col] = selectedId;
      item.used = true;
      state.info = `Заполнено ${boardAssignedCount()} из ${state.size * state.size}.`;
      emitState();
      return;
    }

    if (!canPlayAsPlayer(socket)) return;

    if (state.phase === PHASE.PLAYER_MOVE && state.currentTurn === "player") {
      const move = getLegalMoves(state.marker).find((p) => p.r === row && p.c === col);
      if (!move) return;

      const from = { ...state.marker };
      const path = getPathCells(state.marker, move);
      state.lastPathWords = path.map((cell) => getWordAt(cell.r, cell.c)).filter(Boolean);
      state.marker = { ...move };
      state.phase = PHASE.PLAYER_BLOCK;
      state.info = `${socket.data.role === "teacher" ? "Учитель" : "Игрок"} переместил маркер.`;
      emitState({ animation: { type: "move", actor: "player", from, to: move } });
      return;
    }

    if (state.phase === PHASE.PLAYER_BLOCK && state.currentTurn === "player") {
      const block = getLegalBlocks().find((p) => p.r === row && p.c === col);
      if (!block) return;

      state.blocked[row][col] = true;
      state.phase = PHASE.AWAIT_SENTENCE;
      state.requiredWords = [state.markerWord, ...state.lastPathWords];
      state.sentenceText = "";
      state.sentenceSubmitted = false;
      state.nextMarkerWord = "";
      state.feedback = "Составьте предложение и отправьте учителю.";
      state.info = "Ожидание предложения игрока.";
      emitState({ animation: { type: "block", actor: "player", cell: block } });
      return;
    }
  });

  socket.on("student:submitSentence", ({ text }) => {
    if (!canPlayAsPlayer(socket)) return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Сейчас отправка недоступна.");
      return;
    }

    state.sentenceText = String(text || "");
    state.sentenceSubmitted = true;
    state.feedback = "Предложение отправлено учителю.";
    state.info = "Учитель проверяет ответ.";
    emitState();
  });

  socket.on("teacher:markSentence", async ({ correct }) => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Сейчас нечего проверять.");
      return;
    }

    if (!correct) {
      state.sentenceSubmitted = false;
      state.feedback = "Попробуй еще раз.";
      state.info = "Ответ отмечен как неверный.";
      emitState();
      return;
    }

    if (!state.sentenceSubmitted) {
      sendError(socket, "Сначала игрок должен отправить предложение.");
      return;
    }
    if (!state.nextMarkerWord) {
      sendError(socket, "Сначала подтвердите следующее слово маркера.");
      return;
    }

    state.markerWord = state.nextMarkerWord;
    state.nextMarkerWord = "";
    state.feedback = "Проверка пройдена. Ход передан компьютеру.";
    state.info = "Компьютер начинает ход.";
    state.phase = PHASE.COMPUTER_TURN;
    emitState();

    await runComputerTurn();
  });

  socket.on("student:virtualCheck", async ({ text }) => {
    if (!canPlayAsPlayer(socket)) return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Виртуальная проверка доступна после хода игрока.");
      return;
    }

    const sentence = String(text || "").trim();
    const required = state.requiredWords.slice();
    const local = checkWordOrderLocal(required, sentence);

    let ok = local;
    let message = "Локальная проверка выполнена.";

    try {
      const prompt = [
        "Ты преподаватель немецкого языка.",
        `Требуемый порядок слов: ${required.join(" -> ")}`,
        `Предложение ученика: ${sentence}`,
        "Ответь строго в формате:",
        "RESULT: OK или RESULT: FAIL",
        "FEEDBACK: ...",
        "RULE: ..."
      ].join("\n");

      const answer = await callGemini(prompt);
      ok = /RESULT:\s*OK/i.test(answer) || (local && !/RESULT:\s*FAIL/i.test(answer));
      message = answer;
    } catch (_err) {
      message = local
        ? "Gemini недоступен. Локальная проверка: порядок слов соблюден."
        : "Gemini недоступен. Локальная проверка: порядок слов нарушен.";
    }

    socket.emit("virtual:result", { ok, message });
    if (socket.data.role !== "teacher") {
      io.emit("teacher:virtualLog", {
        who: socket.id,
        ok,
        message,
        sentence
      });
    }
  });

  socket.on("disconnect", () => {
    // no-op
  });
});

server.listen(PORT, () => {
  console.log(`German Sea Trap server started on http://localhost:${PORT}`);
});
