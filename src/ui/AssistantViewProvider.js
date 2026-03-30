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
        case "clearChat":
          this.clearChat();
          break;
        case "setApiKey":
          if (await this.openRouterClient.promptAndStoreApiKey()) {
            this.postInfo("OpenRouter API key сохранен.");
          }
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
    this.postState();
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

    const prompt = String(rawPrompt || "").trim() || DEFAULT_PROMPT;
    this.messages.push(this.createMessage("user", prompt));
    this.busy = true;
    this.status = "Собираю контекст...";
    this.postState();

    try {
      const result = await this.runtime.runTurn({
        prompt,
        history: this.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
        onStatus: (status) => {
          this.status = status;
          this.postState();
        },
        onToolEvent: (event) => {
          this.messages.push(this.createMessage("system", event.summary));
          this.postState();
        },
      });

      this.contextPreview = result.contextPreview;
      this.messages.push(this.createMessage("assistant", result.assistantMessage));
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

  postInfo(text) {
    this.messages.push(this.createMessage("system", text));
    this.postState();
  }

  createMessage(role, content) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content,
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
      },
    });
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
          <button id="clearChat" class="ghost">Очистить</button>
        </div>
      </header>

      <section class="context-card">
        <div class="context-label">Что уходит в модель</div>
        <div id="contextPreview" class="context-preview"></div>
      </section>

      <main id="messages" class="messages"></main>

      <footer class="composer">
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
