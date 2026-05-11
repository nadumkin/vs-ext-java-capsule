(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    busy: false,
    status: "",
    contextPreview: "",
    messages: [],
    canContinue: false,
    canApprove: false,
    approvalMessage: "",
    continuationMessage: "",
    iterationLimit: 8,
    modelName: "",
    baseUrl: "",
    autoApplyChanges: false,
    hasStoredApiKey: false,
  };
  let settingsOpen = false;
  let clearStoredApiKey = false;

  const elements = {
    messages: document.getElementById("messages"),
    prompt: document.getElementById("prompt"),
    sendPrompt: document.getElementById("sendPrompt"),
    clearChat: document.getElementById("clearChat"),
    openSettings: document.getElementById("openSettings"),
    refreshContext: document.getElementById("refreshContext"),
    status: document.getElementById("status"),
    contextPreview: document.getElementById("contextPreview"),
    currentModel: document.getElementById("currentModel"),
    currentEndpoint: document.getElementById("currentEndpoint"),
    apiKeyStatus: document.getElementById("apiKeyStatus"),
    approvalBanner: document.getElementById("approvalBanner"),
    approvalText: document.getElementById("approvalText"),
    applyPendingChanges: document.getElementById("applyPendingChanges"),
    rejectPendingChanges: document.getElementById("rejectPendingChanges"),
    continuationBanner: document.getElementById("continuationBanner"),
    continuationText: document.getElementById("continuationText"),
    continueRun: document.getElementById("continueRun"),
    settingsModal: document.getElementById("settingsModal"),
    closeSettings: document.getElementById("closeSettings"),
    cancelSettings: document.getElementById("cancelSettings"),
    saveSettings: document.getElementById("saveSettings"),
    settingsBaseUrl: document.getElementById("settingsBaseUrl"),
    settingsModel: document.getElementById("settingsModel"),
    settingsApiKey: document.getElementById("settingsApiKey"),
    settingsApiKeyHint: document.getElementById("settingsApiKeyHint"),
    settingsClearApiKeyRow: document.getElementById("settingsClearApiKeyRow"),
    settingsClearApiKey: document.getElementById("settingsClearApiKey"),
    settingsIterationLimit: document.getElementById("settingsIterationLimit"),
    settingsAutoApplyChanges: document.getElementById("settingsAutoApplyChanges"),
  };

  window.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      Object.assign(state, event.data.payload);
      render();
      return;
    }

    if (event.data?.type === "openSettings") {
      openSettingsModal();
    }
  });

  elements.sendPrompt.addEventListener("click", submitPrompt);
  elements.clearChat.addEventListener("click", () =>
    vscode.postMessage({ type: "clearChat" })
  );
  elements.openSettings.addEventListener("click", openSettingsModal);
  elements.refreshContext.addEventListener("click", () =>
    vscode.postMessage({ type: "refreshContext" })
  );
  elements.applyPendingChanges.addEventListener("click", () =>
    vscode.postMessage({ type: "applyPendingChanges" })
  );
  elements.rejectPendingChanges.addEventListener("click", () =>
    vscode.postMessage({ type: "rejectPendingChanges" })
  );
  elements.continueRun.addEventListener("click", continueRun);
  elements.closeSettings.addEventListener("click", closeSettingsModal);
  elements.cancelSettings.addEventListener("click", closeSettingsModal);
  elements.saveSettings.addEventListener("click", saveSettings);
  elements.settingsApiKey.addEventListener("input", () => {
    if (elements.settingsApiKey.value) {
      clearStoredApiKey = false;
      elements.settingsClearApiKey.checked = false;
    }
  });
  elements.settingsClearApiKey.addEventListener("change", () => {
    clearStoredApiKey = Boolean(elements.settingsClearApiKey.checked);
    if (clearStoredApiKey) {
      elements.settingsApiKey.value = "";
    }
  });
  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) {
      closeSettingsModal();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) {
      event.preventDefault();
      closeSettingsModal();
    }
  });

  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  });

  function submitPrompt() {
    if (state.busy || state.canApprove || settingsOpen) {
      return;
    }

    const prompt = elements.prompt.value;
    elements.prompt.value = "";
    vscode.postMessage({
      type: "submitPrompt",
      prompt,
    });
  }

  function continueRun() {
    if (state.busy || !state.canContinue || state.canApprove || settingsOpen) {
      return;
    }

    vscode.postMessage({
      type: "continueRun",
    });
  }

  function openSettingsModal() {
    if (state.busy) {
      return;
    }

    syncSettingsForm();
    setSettingsModalOpen(true);
    elements.settingsBaseUrl.focus();
    render();
  }

  function closeSettingsModal() {
    setSettingsModalOpen(false);
    elements.settingsApiKey.value = "";
    render();
  }

  function setSettingsModalOpen(isOpen) {
    settingsOpen = Boolean(isOpen);
    elements.settingsModal.hidden = !settingsOpen;
    elements.settingsModal.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
  }

  function syncSettingsForm() {
    clearStoredApiKey = false;
    elements.settingsBaseUrl.value = state.baseUrl || "";
    elements.settingsModel.value = state.modelName || "";
    elements.settingsIterationLimit.value = String(state.iterationLimit || 8);
    elements.settingsAutoApplyChanges.checked = Boolean(state.autoApplyChanges);
    elements.settingsApiKey.value = "";
    elements.settingsClearApiKey.checked = false;
    elements.settingsClearApiKeyRow.hidden = !state.hasStoredApiKey;
    elements.settingsApiKey.placeholder = state.hasStoredApiKey
      ? "Сохранен текущий ключ"
      : "Необязателен для локальных endpoint";
    elements.settingsApiKeyHint.textContent = state.hasStoredApiKey
      ? "Поле можно оставить пустым, чтобы сохранить текущий ключ."
      : "Если ваш endpoint требует Bearer token, введите ключ здесь.";
  }

  function saveSettings() {
    if (state.busy) {
      return;
    }

    const baseUrl = String(elements.settingsBaseUrl.value || "").trim();
    const model = String(elements.settingsModel.value || "").trim();
    const apiKey = String(elements.settingsApiKey.value || "");
    const iterationLimit = Number(elements.settingsIterationLimit.value);
    const autoApplyChanges = Boolean(elements.settingsAutoApplyChanges.checked);

    if (!baseUrl) {
      elements.settingsBaseUrl.setCustomValidity("Endpoint обязателен.");
      elements.settingsBaseUrl.reportValidity();
      elements.settingsBaseUrl.focus();
      return;
    }

    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
      elements.settingsBaseUrl.setCustomValidity("");
    } catch (_error) {
      elements.settingsBaseUrl.setCustomValidity("Введите корректный URL с http:// или https://");
      elements.settingsBaseUrl.reportValidity();
      elements.settingsBaseUrl.focus();
      return;
    }

    if (!model) {
      elements.settingsModel.setCustomValidity("Модель обязательна.");
      elements.settingsModel.reportValidity();
      elements.settingsModel.focus();
      return;
    }
    elements.settingsModel.setCustomValidity("");

    if (!Number.isFinite(iterationLimit) || iterationLimit < 1 || iterationLimit > 100) {
      elements.settingsIterationLimit.setCustomValidity(
        "Введите число от 1 до 100."
      );
      elements.settingsIterationLimit.reportValidity();
      elements.settingsIterationLimit.focus();
      return;
    }
    elements.settingsIterationLimit.setCustomValidity("");

    vscode.postMessage({
      type: "saveSettings",
      settings: {
        baseUrl,
        model,
        apiKey,
        clearApiKey: clearStoredApiKey,
        iterationLimit,
        autoApplyChanges,
      },
    });

    closeSettingsModal();
  }

  function render() {
    const inputLocked = state.busy || state.canApprove || settingsOpen;
    const shouldStickToBottom =
      elements.messages.scrollHeight -
        elements.messages.scrollTop -
        elements.messages.clientHeight <
      32;

    elements.sendPrompt.disabled = inputLocked;
    elements.prompt.disabled = inputLocked;
    elements.openSettings.disabled = state.busy;
    elements.refreshContext.disabled = state.busy;
    elements.clearChat.disabled = state.busy;
    elements.continueRun.disabled =
      state.busy || !state.canContinue || state.canApprove || settingsOpen;
    elements.applyPendingChanges.disabled = state.busy || !state.canApprove || settingsOpen;
    elements.rejectPendingChanges.disabled = state.busy || !state.canApprove || settingsOpen;
    elements.saveSettings.disabled = state.busy;
    elements.status.textContent = state.status || "";
    elements.status.classList.toggle("busy", Boolean(state.status));
    elements.contextPreview.textContent = state.contextPreview || "";
    elements.currentModel.textContent = state.modelName || "Модель не выбрана";
    elements.currentEndpoint.textContent = formatEndpointLabel(state.baseUrl);
    elements.apiKeyStatus.textContent = state.hasStoredApiKey
      ? "API key сохранен"
      : "API key не задан";
    setBannerVisible(elements.approvalBanner, Boolean(state.canApprove), "flex");
    elements.approvalText.textContent = state.approvalMessage || "";
    setBannerVisible(
      elements.continuationBanner,
      Boolean(state.canContinue),
      "flex"
    );
    elements.continuationText.textContent = state.continuationMessage || "";
    setSettingsModalOpen(settingsOpen);
    elements.settingsClearApiKeyRow.hidden = !state.hasStoredApiKey;
    elements.settingsBaseUrl.setCustomValidity("");
    elements.settingsModel.setCustomValidity("");
    elements.settingsIterationLimit.setCustomValidity("");

    const fragment = document.createDocumentFragment();
    if (state.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "Сообщения появятся здесь. Агент автоматически приложит текущий файл, локальные импорты и найденные тесты.";
      fragment.appendChild(empty);
    } else {
      for (const message of state.messages) {
        fragment.appendChild(renderMessage(message));
      }
    }

    elements.messages.replaceChildren(fragment);
    if (shouldStickToBottom) {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    }
  }

  function renderMessage(message) {
    if (message.kind === "command") {
      return renderCommandMessage(message);
    }
    if (message.kind === "change") {
      return renderChangeMessage(message);
    }
    if (message.kind === "memory") {
      return renderMemoryMessage(message);
    }

    const item = document.createElement("article");
    item.className = `message message-${message.role}`;

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = roleLabel(message.role);

    const body = document.createElement("pre");
    body.className = "message-body";
    body.textContent = message.content;

    item.appendChild(role);
    item.appendChild(body);
    return item;
  }

  function renderChangeMessage(message) {
    const item = document.createElement("article");
    item.className = `message change-block change-${message.status || "pending"}`;

    const header = document.createElement("div");
    header.className = "change-header";

    const title = document.createElement("div");
    title.className = "change-title";
    title.textContent = message.title || "File change";

    const badge = document.createElement("span");
    badge.className = "change-badge";
    badge.textContent = changeStatusLabel(message.status);

    header.appendChild(title);
    header.appendChild(badge);
    item.appendChild(header);

    if (message.summary) {
      const summary = document.createElement("div");
      summary.className = "change-summary";
      summary.textContent = message.summary;
      item.appendChild(summary);
    }

    if (message.path) {
      const path = document.createElement("pre");
      path.className = "change-path";
      path.textContent = message.path;
      item.appendChild(path);
    }

    const meta = document.createElement("div");
    meta.className = "change-meta";

    if (message.mode) {
      meta.appendChild(renderChangeChip(changeModeLabel(message.mode)));
    }

    if (message.status) {
      meta.appendChild(renderChangeChip(changeStatusLabel(message.status)));
    }

    if (meta.childNodes.length > 0) {
      item.appendChild(meta);
    }

    return item;
  }

  function renderChangeChip(text) {
    const chip = document.createElement("span");
    chip.className = "change-chip";
    chip.textContent = text;
    return chip;
  }

  function renderMemoryMessage(message) {
    const item = document.createElement("article");
    item.className = "message memory-block";

    const header = document.createElement("div");
    header.className = "memory-header";

    const title = document.createElement("div");
    title.className = "memory-title";
    title.textContent = message.title || "Memory";

    const badge = document.createElement("span");
    badge.className = "memory-badge";
    badge.textContent = `TOP ${(message.predictions || []).length}`;

    header.appendChild(title);
    header.appendChild(badge);
    item.appendChild(header);

    if (message.summary) {
      const summary = document.createElement("div");
      summary.className = "memory-summary";
      summary.textContent = message.summary;
      item.appendChild(summary);
    }

    const predictions = message.predictions || [];
    if (predictions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "memory-empty";
      empty.textContent = "Похожих прошлых diff-ов пока нет.";
      item.appendChild(empty);
      return item;
    }

    const list = document.createElement("ol");
    list.className = "memory-list";

    for (const prediction of predictions) {
      const entry = document.createElement("li");
      entry.className = "memory-entry";

      const head = document.createElement("div");
      head.className = "memory-entry-head";
      const scoreText = `score ${formatScore(prediction.score)}`;
      const fileText = (prediction.files || []).join(", ") || "—";
      head.textContent = `${scoreText} • ${fileText}`;
      entry.appendChild(head);

      if (prediction.success) {
        const status = document.createElement("div");
        status.className = "memory-status memory-status-ok";
        status.textContent = "Прошлый запуск: успех";
        entry.appendChild(status);
      }

      const failures = prediction.failures || [];
      for (const failure of failures.slice(0, 3)) {
        const failureBlock = document.createElement("div");
        failureBlock.className = "memory-failure";

        const headerLine = document.createElement("div");
        headerLine.className = "memory-failure-head";
        headerLine.textContent = failure.message
          ? `${failure.exception}: ${failure.message}`
          : failure.exception;
        failureBlock.appendChild(headerLine);

        const frames = failure.frames || [];
        if (frames.length > 0) {
          const stack = document.createElement("pre");
          stack.className = "memory-failure-stack";
          stack.textContent = frames
            .map((frame) => `at ${frame.class}.${frame.method}(${frame.location})`)
            .join("\n");
          failureBlock.appendChild(stack);
        }

        entry.appendChild(failureBlock);
      }

      if (failures.length > 3) {
        const more = document.createElement("div");
        more.className = "memory-more";
        more.textContent = `... ещё ${failures.length - 3} падений.`;
        entry.appendChild(more);
      }

      list.appendChild(entry);
    }

    item.appendChild(list);
    return item;
  }

  function formatScore(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return "—";
    }
    return num.toFixed(2);
  }

  function renderCommandMessage(message) {
    const item = document.createElement("article");
    item.className = `message command-block command-${message.status || "info"}`;

    const header = document.createElement("div");
    header.className = "command-header";

    const title = document.createElement("div");
    title.className = "command-title";
    title.textContent = message.title || "Command";

    const badge = document.createElement("span");
    badge.className = "command-badge";
    badge.textContent = commandStatusLabel(message);

    header.appendChild(title);
    header.appendChild(badge);
    item.appendChild(header);

    if (message.summary) {
      const summary = document.createElement("div");
      summary.className = "command-summary";
      summary.textContent = message.summary;
      item.appendChild(summary);
    }

    if (message.commandText) {
      item.appendChild(renderCommandSection("Command", message.commandText, true));
    }

    if (message.cwd) {
      item.appendChild(renderCommandSection("CWD", message.cwd));
    }

    if (typeof message.sessionId === "number") {
      item.appendChild(renderCommandSection("Session", `#${message.sessionId}`));
    }

    if (typeof message.exitCode === "number") {
      item.appendChild(renderCommandSection("Exit code", String(message.exitCode)));
    }

    if (message.output) {
      item.appendChild(renderCommandSection("Output", message.output, true));
    }

    if (message.stdout) {
      item.appendChild(renderCommandSection("stdout", message.stdout, true));
    }

    if (message.stderr) {
      item.appendChild(renderCommandSection("stderr", message.stderr, true));
    }

    return item;
  }

  function renderCommandSection(label, content, code = false) {
    const section = document.createElement("section");
    section.className = "command-section";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "command-section-label";
    sectionLabel.textContent = label;

    const body = document.createElement(code ? "pre" : "div");
    body.className = code ? "command-section-code" : "command-section-body";
    body.textContent = content || "";

    section.appendChild(sectionLabel);
    section.appendChild(body);
    return section;
  }

  function commandStatusLabel(message) {
    if (message.status === "success") {
      return "OK";
    }
    if (message.status === "error") {
      return "ERROR";
    }
    if (message.status === "timeout") {
      return "TIMEOUT";
    }
    if (message.status === "cancelled") {
      return "CANCELLED";
    }
    if (message.status === "running") {
      return "RUNNING";
    }
    return "INFO";
  }

  function changeStatusLabel(status) {
    if (status === "applied") {
      return "APPLIED";
    }
    if (status === "rejected") {
      return "REJECTED";
    }
    return "PENDING";
  }

  function changeModeLabel(mode) {
    if (mode === "create") {
      return "CREATE";
    }
    return "UPDATE";
  }

  function roleLabel(role) {
    if (role === "assistant") {
      return "Agent";
    }
    if (role === "user") {
      return "You";
    }
    return "System";
  }

  function formatEndpointLabel(baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      return `${parsed.host}${parsed.pathname}`;
    } catch (_error) {
      return String(baseUrl || "").trim() || "Endpoint не задан";
    }
  }

  function setBannerVisible(element, visible, displayValue) {
    if (!element) {
      return;
    }
    element.hidden = !visible;
    if (visible) {
      element.style.setProperty("display", displayValue, "important");
    } else {
      element.style.setProperty("display", "none", "important");
    }
  }

  vscode.postMessage({ type: "ready" });
})();
