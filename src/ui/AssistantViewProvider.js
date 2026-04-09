const vscode = require("vscode");

const DEFAULT_PROMPT =
  "Проанализируй текущий контекст и выполни самое полезное следующее действие.";

class AssistantViewProvider {
  static viewType = "aiAgentAssistant.chatView";

  constructor(context, runtime, openRouterClient) {
    this.context = context;
    this.runtime = runtime;
    this.openRouterClient = openRouterClient;
    this.view = undefined;
    this.messages = [];
    this.busy = false;
    this.status = "";
    this.contextPreview = "Откройте файл с классом, чтобы подготовить контекст.";
    this.iterationLimit = this.getConfiguredIterationLimit();
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          await this.refreshContextPreview();
          this.postState();
          break;
        case "submitPrompt":
          await this.handleSubmitPrompt(message.prompt);
          break;
        case "continueRun":
          await this.handleContinueRun();
          break;
        case "clearChat":
          this.clearChat();
          break;
        case "setApiKey":
          if (await this.openRouterClient.promptAndStoreApiKey()) {
            this.postInfo("OpenRouter API key сохранен.");
          }
          break;
        case "setIterationLimitPrompt":
          await this.promptAndStoreIterationLimit();
          break;
        case "refreshContext":
          await this.refreshContextPreview();
          break;
        default:
          break;
      }
    });
  }

  async focus() {
    await vscode.commands.executeCommand(
      "workbench.view.extension.aiAgentAssistantContainer"
    );
  }

  clearChat() {
    this.messages = [];
    this.status = "";
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.postState();
  }

  async promptAndStoreIterationLimit() {
    const entered = await vscode.window.showInputBox({
      title: "Agent Iteration Limit",
      prompt: "Введите максимальное количество итераций агента на один прогон.",
      ignoreFocusOut: true,
      value: String(this.iterationLimit),
      validateInput: (value) => {
        const normalized = Number(value);
        if (!Number.isFinite(normalized) || normalized < 1 || normalized > 100) {
          return "Введите число от 1 до 100.";
        }
        return undefined;
      },
    });

    if (!entered) {
      return false;
    }

    const normalized = this.normalizeIterationLimit(entered);
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .update("agent.maxIterations", normalized, target);

    this.iterationLimit = normalized;
    this.postInfo(`Лимит итераций обновлен: ${normalized}`);
    this.postState();
    return true;
  }

  async refreshContextPreview() {
    try {
      const preview = await this.runtime.previewContext();
      this.contextPreview = preview.summaryText;
    } catch (error) {
      this.contextPreview = error.message;
    }

    this.postState();
  }

  async handleSubmitPrompt(rawPrompt) {
    if (this.busy) {
      return;
    }

    this.pendingContinuation = undefined;
    this.continuationMessage = "";

    const prompt = String(rawPrompt || "").trim() || DEFAULT_PROMPT;
    this.messages.push(this.createMessage("user", prompt));
    this.busy = true;
    this.status = "Собираю контекст...";
    this.postState();

    try {
      await this.runAgentTurn({
        prompt,
        history: this.messages
          .slice(0, -1)
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
        iterationLimit: this.iterationLimit,
      });
    } catch (error) {
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка во время работы агента:\n${error.message}`
        )
      );
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async handleContinueRun() {
    if (this.busy || !this.pendingContinuation) {
      return;
    }

    const continuationState = this.pendingContinuation;
    const continuationMessage = this.continuationMessage;
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.busy = true;
    this.status = "Возобновляю агентную сессию...";
    this.postState();

    try {
      await this.runAgentTurn({
        iterationLimit: this.iterationLimit,
        continuationState,
      });
    } catch (error) {
      this.pendingContinuation = continuationState;
      this.continuationMessage = continuationMessage;
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка во время продолжения:\n${error.message}`
        )
      );
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async runAgentTurn({ prompt = "", history = [], iterationLimit, continuationState }) {
    const result = await this.runtime.runTurn({
      prompt,
      history,
      iterationLimit,
      continuationState,
      onStatus: (status) => {
        this.status = status;
        this.postState();
      },
      onToolEvent: (event) => {
        this.handleToolEvent(event);
      },
    });

    this.contextPreview = result.contextPreview || this.contextPreview;

    if (result.status === "completed") {
      this.pendingContinuation = undefined;
      this.continuationMessage = "";
      this.messages.push(this.createMessage("assistant", result.assistantMessage));
      return;
    }

    if (result.status === "needsContinuation") {
      this.pendingContinuation = result.continuationState;
      this.continuationMessage = result.continuationMessage;
      this.messages.push(this.createMessage("system", result.continuationMessage));
    }
  }

  postInfo(text) {
    this.messages.push(this.createMessage("system", text));
    this.postState();
  }

  handleToolEvent(event) {
    if (event.displayMessage) {
      this.upsertMessage(this.createMessage("command", "", event.displayMessage));
    } else if (event.summary) {
      this.messages.push(this.createMessage("system", event.summary));
    }
    this.postState();
  }

  upsertMessage(message) {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index === -1) {
      this.messages.push(message);
      return;
    }

    this.messages[index] = {
      ...this.messages[index],
      ...message,
    };
  }

  createMessage(role, content, extras = {}) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content,
      ...extras,
    };
  }

  postState() {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: "state",
      payload: {
        busy: this.busy,
        status: this.status,
        contextPreview: this.contextPreview,
        messages: this.messages,
        canContinue: Boolean(this.pendingContinuation),
        continuationMessage: this.continuationMessage,
        iterationLimit: this.iterationLimit,
      },
    });
  }

  getConfiguredIterationLimit() {
    const configured = vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("agent.maxIterations", 8);
    return this.normalizeIterationLimit(configured, 8);
  }

  reloadConfiguredIterationLimit() {
    this.iterationLimit = this.getConfiguredIterationLimit();
    this.postState();
  }

  normalizeIterationLimit(value, fallback) {
    const base = Number(value);
    const normalized = Number.isFinite(base) ? base : fallback || 8;
    return Math.max(1, Math.min(100, Math.round(normalized)));
  }

  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css")
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>AI Agent Assistant</title>
  </head>
  <body>
    <div class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">AI Agent Assistant</p>
          <h1>Контекстный кодовый агент</h1>
          <p class="subtitle">OpenRouter + файлы + тесты + действия над проектом</p>
        </div>
        <div class="toolbar">
          <button id="refreshContext" class="ghost">Контекст</button>
          <button id="setApiKey" class="ghost">API key</button>
          <button id="setIterationLimitPrompt" class="ghost">Итерации</button>
          <button id="clearChat" class="ghost">Очистить</button>
        </div>
      </header>

      <section class="context-card">
        <div class="context-label">Что уходит в модель</div>
        <div id="contextPreview" class="context-preview"></div>
      </section>

      <main id="messages" class="messages"></main>

      <footer class="composer">
        <div id="continuationBanner" class="continuation-banner" hidden>
          <div id="continuationText" class="continuation-text"></div>
          <button id="continueRun" class="ghost highlight">Продолжить</button>
        </div>
        <label class="composer-label" for="prompt">Запрос к агенту</label>
        <textarea
          id="prompt"
          rows="4"
          placeholder="Например: исправь класс, обнови тесты и прогоняй npm test"
        ></textarea>
        <div class="composer-actions">
          <div id="status" class="status"></div>
          <button id="sendPrompt" class="primary">Отправить</button>
        </div>
      </footer>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce() {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

module.exports = {
  AssistantViewProvider,
};
