(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    busy: false,
    status: "",
    contextPreview: "",
    messages: [],
  };

  const elements = {
    messages: document.getElementById("messages"),
    prompt: document.getElementById("prompt"),
    sendPrompt: document.getElementById("sendPrompt"),
    clearChat: document.getElementById("clearChat"),
    setApiKey: document.getElementById("setApiKey"),
    refreshContext: document.getElementById("refreshContext"),
    status: document.getElementById("status"),
    contextPreview: document.getElementById("contextPreview"),
  };

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "state") {
      return;
    }

    Object.assign(state, event.data.payload);
    render();
  });

  elements.sendPrompt.addEventListener("click", submitPrompt);
  elements.clearChat.addEventListener("click", () =>
    vscode.postMessage({ type: "clearChat" })
  );
  elements.setApiKey.addEventListener("click", () =>
    vscode.postMessage({ type: "setApiKey" })
  );
  elements.refreshContext.addEventListener("click", () =>
    vscode.postMessage({ type: "refreshContext" })
  );

  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  });

  function submitPrompt() {
    if (state.busy) {
      return;
    }

    const prompt = elements.prompt.value;
    elements.prompt.value = "";
    vscode.postMessage({
      type: "submitPrompt",
      prompt,
    });
  }

  function render() {
    elements.sendPrompt.disabled = state.busy;
    elements.prompt.disabled = state.busy;
    elements.status.textContent = state.status || "";
    elements.status.classList.toggle("busy", Boolean(state.status));
    elements.contextPreview.textContent = state.contextPreview || "";

    const fragment = document.createDocumentFragment();
    if (state.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "Сообщения появятся здесь. Агент автоматически приложит текущий файл, локальные импорты и найденные тесты.";
      fragment.appendChild(empty);
    } else {
      for (const message of state.messages) {
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
        fragment.appendChild(item);
      }
    }

    elements.messages.replaceChildren(fragment);
    elements.messages.scrollTop = elements.messages.scrollHeight;
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

  vscode.postMessage({ type: "ready" });
})();
