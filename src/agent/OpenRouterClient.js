const vscode = require("vscode");

const SECRET_KEY = "aiAgentAssistant.openRouter.apiKey";

class OpenRouterClient {
  constructor(secretStorage) {
    this.secretStorage = secretStorage;
  }

  async getApiKey() {
    return (
      (await this.secretStorage.get(SECRET_KEY)) ||
      process.env.OPENROUTER_API_KEY ||
      ""
    );
  }

  async promptAndStoreApiKey() {
    const current = await this.getApiKey();
    const apiKey = await vscode.window.showInputBox({
      title: "OpenRouter API Key",
      prompt: "Введите OpenRouter API key. Ключ будет сохранен в VS Code Secret Storage.",
      password: true,
      ignoreFocusOut: true,
      value: current,
    });

    if (!apiKey) {
      return false;
    }

    await this.secretStorage.store(SECRET_KEY, apiKey.trim());
    vscode.window.showInformationMessage("OpenRouter API key сохранен.");
    return true;
  }

  async createChatCompletion({ messages, tools }) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        "OpenRouter API key не найден. Выполните команду 'AI Agent: Set OpenRouter API Key'."
      );
    }

    if (typeof fetch !== "function") {
      throw new Error("Глобальный fetch недоступен в extension host.");
    }

    const config = vscode.workspace.getConfiguration("aiAgentAssistant");
    const model = config.get("openRouter.model", "openai/gpt-5.2");
    const baseUrl = config.get(
      "openRouter.baseUrl",
      "https://openrouter.ai/api/v1/chat/completions"
    );
    const timeoutMs = Number(config.get("openRouter.requestTimeoutMs", 120000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "VS Code AI Agent Assistant",
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.1,
          stream: false,
        }),
      });

      const raw = await response.text();
      const payload = raw ? tryParseJson(raw) : undefined;

      if (!response.ok) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          raw ||
          `OpenRouter returned HTTP ${response.status}`;
        throw new Error(message);
      }

      if (!payload) {
        throw new Error("OpenRouter вернул пустой ответ.");
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          `Запрос к OpenRouter превысил timeout ${timeoutMs} мс.`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return undefined;
  }
}

module.exports = {
  OpenRouterClient,
};
