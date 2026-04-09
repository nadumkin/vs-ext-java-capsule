(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    busy: false,
    status: "",
    contextPreview: "",
    messages: [],
    canContinue: false,
    continuationMessage: "",
    iterationLimit: 8,
  };

  const elements = {
    messages: document.getElementById("messages"),
    prompt: document.getElementById("prompt"),
    sendPrompt: document.getElementById("sendPrompt"),
    clearChat: document.getElementById("clearChat"),
    setApiKey: document.getElementById("setApiKey"),
    setIterationLimitPrompt: document.getElementById("setIterationLimitPrompt"),
    refreshContext: document.getElementById("refreshContext"),
    status: document.getElementById("status"),
    contextPreview: document.getElementById("contextPreview"),
    continuationBanner: document.getElementById("continuationBanner"),
    continuationText: document.getElementById("continuationText"),
    continueRun: document.getElementById("continueRun"),
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
  elements.setIterationLimitPrompt.addEventListener("click", () =>
    vscode.postMessage({ type: "setIterationLimitPrompt" })
  );
  elements.refreshContext.addEventListener("click", () =>
    vscode.postMessage({ type: "refreshContext" })
  );
  elements.continueRun.addEventListener("click", continueRun);

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

  function continueRun() {
    if (state.busy || !state.canContinue) {
      return;
    }

    vscode.postMessage({
      type: "continueRun",
    });
  }

  function render() {
    const shouldStickToBottom =
      elements.messages.scrollHeight -
        elements.messages.scrollTop -
        elements.messages.clientHeight <
      32;

    elements.sendPrompt.disabled = state.busy;
    elements.prompt.disabled = state.busy;
    elements.continueRun.disabled = state.busy || !state.canContinue;
    elements.status.textContent = state.status || "";
    elements.status.classList.toggle("busy", Boolean(state.status));
    elements.contextPreview.textContent = state.contextPreview || "";
    elements.continuationBanner.hidden = !state.canContinue;
    elements.continuationText.textContent = state.continuationMessage || "";

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
