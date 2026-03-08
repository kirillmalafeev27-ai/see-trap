(() => {
  const { PHASE, legalMoves, legalBlocks, createBoardRenderer } = window.SeaTrapShared;

  const socket = io({ auth: { role: "teacher" } });

  const els = {
    sizeSelect: document.getElementById("sizeSelect"),
    board: document.getElementById("board"),
    phaseText: document.getElementById("phaseText"),
    infoText: document.getElementById("infoText"),
    instructionText: document.getElementById("instructionText"),
    requiredWords: document.getElementById("requiredWords"),
    sentencePreview: document.getElementById("sentencePreview"),
    logBox: document.getElementById("logBox"),

    wordContainer: document.getElementById("wordContainer"),
    loadWordsBtn: document.getElementById("loadWordsBtn"),
    shuffleBoardBtn: document.getElementById("shuffleBoardBtn"),
    loadStatus: document.getElementById("loadStatus"),

    wordButtons: document.getElementById("wordButtons"),
    wordHint: document.getElementById("wordHint"),

    markerStatus: document.getElementById("markerStatus"),
    nextMarkerStatus: document.getElementById("nextMarkerStatus"),
    finishPlacementBtn: document.getElementById("finishPlacementBtn"),
    confirmMarkerBtn: document.getElementById("confirmMarkerBtn"),
    setNextMarkerBtn: document.getElementById("setNextMarkerBtn"),
    aiMarkerBtn: document.getElementById("aiMarkerBtn"),

    teacherCorrectBtn: document.getElementById("teacherCorrectBtn"),
    teacherWrongBtn: document.getElementById("teacherWrongBtn")
  };

  let state = null;
  let selectedWordId = null;
  let lastLog = "Ожидание событий.";

  const renderer = createBoardRenderer(els.board, (r, c) => {
    if (!state) return;

    if (state.phase === PHASE.SETUP_WORDS) {
      if (selectedWordId == null) return;
      socket.emit("game:cellClick", { r, c, wordId: selectedWordId });
      return;
    }

    if (state.phase === PHASE.PLAYER_MOVE || state.phase === PHASE.PLAYER_BLOCK) {
      socket.emit("game:cellClick", { r, c });
    }
  });

  function setLog(text, tone = "") {
    lastLog = text;
    els.logBox.textContent = text;
    els.logBox.className = "feedback";
    if (tone) els.logBox.classList.add(tone);
    else els.logBox.classList.add("muted");
  }

  function phaseLabel(phase) {
    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Подготовка: заполнение слов";
      case PHASE.SETUP_MARKER:
        return "Подготовка: выбор стартового слова маркера";
      case PHASE.PLAYER_MOVE:
        return "Ход игрока: перемещение";
      case PHASE.PLAYER_BLOCK:
        return "Ход игрока: постановка мины";
      case PHASE.AWAIT_SENTENCE:
        return "Ожидание и проверка предложения";
      case PHASE.COMPUTER_TURN:
        return "Ход компьютера";
      case PHASE.GAME_OVER:
        return "Игра завершена";
      default:
        return phase;
    }
  }

  function instructionForPhase(phase) {
    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Выберите слово справа и кликайте клетки поля. Нужно заполнить все клетки.";
      case PHASE.SETUP_MARKER:
        return "Выберите стартовое слово маркера и подтвердите.";
      case PHASE.PLAYER_MOVE:
        return "Игрок (или вы) выбирает зеленую клетку для перемещения.";
      case PHASE.PLAYER_BLOCK:
        return "Игрок (или вы) выбирает оранжевую клетку для мины.";
      case PHASE.AWAIT_SENTENCE:
        return "Проверьте предложение: сначала выберите следующее слово маркера, затем нажмите Правильно/Неправильно.";
      case PHASE.COMPUTER_TURN:
        return "Компьютер делает ход автоматически.";
      case PHASE.GAME_OVER:
        return `Победитель: ${state?.winner === "player" ? "Игрок" : "Компьютер"}.`;
      default:
        return "";
    }
  }

  function renderRequiredWords() {
    els.requiredWords.innerHTML = "";
    const words = state.requiredWords?.length ? state.requiredWords : ["Пока нет"];
    for (const word of words) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = word;
      els.requiredWords.appendChild(chip);
    }
  }

  function renderWordButtons() {
    els.wordButtons.innerHTML = "";

    for (const item of state.wordPool || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "word-btn";
      btn.textContent = item.word;

      if (state.phase === PHASE.SETUP_WORDS && item.used) btn.classList.add("used");
      if (selectedWordId === item.id) btn.classList.add("active");

      btn.addEventListener("click", () => {
        if (state.phase === PHASE.SETUP_WORDS && item.used) return;
        selectedWordId = item.id;
        renderWordButtons();
        renderStatusOnly();
      });

      els.wordButtons.appendChild(btn);
    }
  }

  function renderStatusOnly() {
    if (!state) return;

    els.phaseText.textContent = phaseLabel(state.phase);
    els.infoText.textContent = state.info || "";
    els.instructionText.textContent = instructionForPhase(state.phase);

    els.sentencePreview.textContent = state.sentenceSubmitted
      ? (state.sentenceText || "(пустая строка)")
      : "Игрок еще ничего не отправил.";
    els.sentencePreview.className = "feedback" + (state.sentenceSubmitted ? "" : " muted");

    const total = state.size * state.size;
    const assigned = state.boardWordIds.flat().filter((x) => x != null).length;
    els.loadStatus.textContent = `Заполнено клеток: ${assigned}/${total}`;
    els.loadStatus.className = assigned === total ? "muted ok" : "muted warn";

    if (!state.markerWord) {
      els.markerStatus.textContent = "Стартовое слово маркера не выбрано.";
      els.markerStatus.className = "muted";
    } else {
      els.markerStatus.textContent = `Текущее слово маркера: ${state.markerWord}`;
      els.markerStatus.className = "muted ok";
    }

    if (!state.nextMarkerWord) {
      els.nextMarkerStatus.textContent = "Следующее слово маркера не выбрано.";
      els.nextMarkerStatus.className = state.phase === PHASE.AWAIT_SENTENCE ? "muted warn" : "muted";
    } else {
      els.nextMarkerStatus.textContent = `Следующее слово маркера: ${state.nextMarkerWord}`;
      els.nextMarkerStatus.className = "muted ok";
    }

    const setupWords = state.phase === PHASE.SETUP_WORDS;
    const setupMarker = state.phase === PHASE.SETUP_MARKER;
    const awaitSentence = state.phase === PHASE.AWAIT_SENTENCE;

    els.shuffleBoardBtn.disabled = !setupWords || assigned !== total;
    els.finishPlacementBtn.disabled = !setupWords || assigned !== total;
    els.confirmMarkerBtn.disabled = !setupMarker || selectedWordId == null;
    els.setNextMarkerBtn.disabled = !awaitSentence || selectedWordId == null;
    els.aiMarkerBtn.disabled = !awaitSentence;

    els.teacherCorrectBtn.disabled = !awaitSentence;
    els.teacherWrongBtn.disabled = !awaitSentence;

    if (setupWords) {
      els.wordHint.textContent = "Выберите слово и кликните клетку поля.";
    } else if (setupMarker) {
      els.wordHint.textContent = "Выберите слово и нажмите «Готово: стартовое слово».";
    } else if (awaitSentence) {
      els.wordHint.textContent = "Выберите слово как следующее для маркера или используйте AI.";
    } else {
      els.wordHint.textContent = "Список слов доступен для просмотра.";
    }
  }

  function renderBoardAndStatus() {
    if (!state) return;

    const reach = state.phase === PHASE.PLAYER_MOVE ? legalMoves(state) : [];
    const blocks = state.phase === PHASE.PLAYER_BLOCK ? legalBlocks(state) : [];
    const setupActive = state.phase === PHASE.SETUP_WORDS && selectedWordId != null;

    renderer.render(state, { reach, blocks, setupActive });
    renderRequiredWords();
    renderWordButtons();
    renderStatusOnly();
  }

  socket.on("session:role", ({ role }) => {
    setLog(`Подключено как: ${role}`, "ok");
  });

  socket.on("state:update", ({ state: serverState, animation }) => {
    state = serverState;
    if (state && Number(els.sizeSelect.value) !== state.size) {
      els.sizeSelect.value = String(state.size);
    }
    renderBoardAndStatus();

    if (animation?.type === "move") {
      setLog(`Анимация: ${animation.actor === "player" ? "игрок" : "компьютер"} переместил маркер.`, "ok");
    }
    if (animation?.type === "block") {
      setLog(`Анимация: ${animation.actor === "player" ? "игрок" : "компьютер"} поставил мину.`, "warn");
    }
  });

  socket.on("action:error", ({ message }) => {
    setLog(message, "bad");
  });

  socket.on("action:info", ({ message }) => {
    setLog(message, "ok");
  });

  socket.on("teacher:virtualLog", ({ ok, message, sentence }) => {
    setLog(`Виртуальная проверка (${ok ? "OK" : "FAIL"})\nПредложение: ${sentence || "(пусто)"}\n${message}`, ok ? "ok" : "warn");
  });

  els.sizeSelect.addEventListener("change", () => {
    socket.emit("teacher:setSize", { size: Number(els.sizeSelect.value) });
    selectedWordId = null;
  });

  els.loadWordsBtn.addEventListener("click", () => {
    socket.emit("teacher:loadWords", { raw: els.wordContainer.value });
    selectedWordId = null;
  });

  els.shuffleBoardBtn.addEventListener("click", () => {
    socket.emit("teacher:shuffleBoardWords");
  });

  els.finishPlacementBtn.addEventListener("click", () => {
    socket.emit("teacher:finishWordPlacement");
  });

  els.confirmMarkerBtn.addEventListener("click", () => {
    if (selectedWordId == null) return;
    socket.emit("teacher:setInitialMarkerWord", { wordId: selectedWordId });
  });

  els.setNextMarkerBtn.addEventListener("click", () => {
    if (selectedWordId == null) return;
    socket.emit("teacher:setNextMarkerWord", { wordId: selectedWordId });
  });

  els.aiMarkerBtn.addEventListener("click", () => {
    socket.emit("teacher:generateNextMarkerWord");
  });

  els.teacherCorrectBtn.addEventListener("click", () => {
    socket.emit("teacher:markSentence", { correct: true });
  });

  els.teacherWrongBtn.addEventListener("click", () => {
    socket.emit("teacher:markSentence", { correct: false });
  });

  window.addEventListener("resize", () => {
    if (state) renderer.forceShipPosition(state);
  });
})();
