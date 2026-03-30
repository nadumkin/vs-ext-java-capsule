class AgentRuntime {
  constructor({ contextCollector, openRouterClient, toolExecutor, outputChannel }) {
    this.contextCollector = contextCollector;
    this.openRouterClient = openRouterClient;
    this.toolExecutor = toolExecutor;
    this.outputChannel = outputChannel;
    this.maxIterations = 8;
  }

  async previewContext() {
    return this.contextCollector.previewContext();
  }

  async runTurn({ prompt, history, onStatus, onToolEvent }) {
    onStatus?.("Собираю файл, импорты и тесты...");
    const context = await this.contextCollector.collectContext(prompt);
    const messages = this.buildMessages(history, context.promptText);
    const tools = this.toolExecutor.getToolDefinitions();

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      onStatus?.(
        iteration === 0
          ? "Отправляю контекст в OpenRouter..."
          : `Продолжаю agent loop (${iteration + 1}/${this.maxIterations})...`
      );

      const response = await this.openRouterClient.createChatCompletion({
        messages,
        tools,
      });
      const choice = response?.choices?.[0];

      if (!choice?.message) {
        throw new Error("OpenRouter вернул ответ без choices[0].message.");
      }

      const assistantMessage = normalizeAssistantMessage(choice.message);
      messages.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls || [];

      if (toolCalls.length === 0) {
        return {
          assistantMessage:
            extractText(assistantMessage.content) || "Готово. Изменения применены.",
          contextPreview: context.summaryText,
        };
      }

      if (extractText(assistantMessage.content)) {
        onToolEvent?.({
          summary: `Промежуточный ответ агента: ${extractText(
            assistantMessage.content
          )}`,
        });
      }

      for (const toolCall of toolCalls) {
        onStatus?.(`Выполняю инструмент ${toolCall.function?.name}...`);
        const result = await this.toolExecutor.executeToolCall(toolCall);
        messages.push(result.toolMessage);
        onToolEvent?.({
          summary: result.summary,
        });
      }
    }

    throw new Error(
      `Agent loop остановлен: достигнут лимит ${this.maxIterations} итераций.`
    );
  }

  buildMessages(history, currentPrompt) {
    const preservedHistory = history.slice(-12).map((item) => ({
      role: item.role,
      content: item.content,
    }));

    return [
      {
        role: "system",
        content: [
          "You are a VS Code coding assistant with project tools.",
          "Work in the user's language when reasonable.",
          "You receive an up-to-date context snapshot on every turn.",
          "Use tools to read files, modify files, search the workspace, and run commands.",
          "Prefer actual tool execution over describing intended edits.",
          "When editing files, write the complete final content.",
          "Avoid destructive or risky actions unless they are clearly necessary.",
          "After tool usage, provide a concise final answer summarizing what changed and any next verification step.",
        ].join(" "),
      },
      ...preservedHistory,
      {
        role: "user",
        content: currentPrompt,
      },
    ];
  }
}

function normalizeAssistantMessage(message) {
  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: message.tool_calls || message.toolCalls || [],
  };
}

function extractText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();
  }

  return "";
}

module.exports = {
  AgentRuntime,
};
