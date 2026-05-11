class AgentRuntime {
  constructor({ contextCollector, openRouterClient, toolExecutor, outputChannel }) {
    this.contextCollector = contextCollector;
    this.openRouterClient = openRouterClient;
    this.toolExecutor = toolExecutor;
    this.outputChannel = outputChannel;
  }

  async previewContext() {
    return this.contextCollector.previewContext();
  }

  async applyPendingChanges() {
    return this.toolExecutor.applyPendingChanges();
  }

  async rejectPendingChanges() {
    return this.toolExecutor.rejectPendingChanges();
  }

  async runTurn({
    prompt,
    history,
    iterationLimit,
    continuationState,
    onStatus,
    onToolEvent,
  }) {
    let contextPreview = continuationState?.contextPreview || "";
    let messages;

    if (continuationState?.messages?.length) {
      messages = cloneMessages(continuationState.messages);
      onStatus?.("Продолжаю агентную сессию с сохраненного шага...");
    } else {
      onStatus?.("Собираю файл, импорты и тесты...");
      const context = await this.contextCollector.collectContext(prompt);
      messages = this.buildMessages(history, context.promptText);
      contextPreview = context.summaryText;
    }

    const tools = this.toolExecutor.getToolDefinitions();
    const maxIterations = normalizeIterationLimit(iterationLimit);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      onStatus?.(
        iteration === 0
          ? "Отправляю контекст в LLM endpoint..."
          : `Продолжаю agent loop (${iteration + 1}/${maxIterations})...`
      );

      const response = await this.openRouterClient.createChatCompletion({
        messages,
        tools,
      });
      const choice = response?.choices?.[0];

      if (!choice?.message) {
        throw new Error("LLM endpoint вернул ответ без choices[0].message.");
      }

      const assistantMessage = normalizeAssistantMessage(choice.message);
      messages.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls || [];

      if (toolCalls.length === 0) {
        return {
          status: "completed",
          assistantMessage:
            extractText(assistantMessage.content) || "Готово. Изменения применены.",
          contextPreview,
        };
      }

      const assistantText = extractText(assistantMessage.content);
      if (assistantText) {
        onToolEvent?.({
          summary: `Промежуточный ответ агента: ${assistantText}`,
        });
      }

      let approvalRequested = false;
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index];
        onStatus?.(`Выполняю инструмент ${toolCall.function?.name}...`);
        const result = await this.toolExecutor.executeToolCall(toolCall, {
          onEvent: (event) => {
            onToolEvent?.(event);
          },
        });
        messages.push(result.toolMessage);
        onToolEvent?.({
          summary: result.summary,
          displayMessage: result.displayMessage,
        });

        if (result.requiresApproval) {
          approvalRequested = true;
          const nextToolName = toolCalls[index + 1]?.function?.name;
          if (!nextToolName || !this.toolExecutor.isDeferredFileChangeTool(nextToolName)) {
            break;
          }
        }
      }

      if (approvalRequested) {
        return {
          status: "needsApproval",
          contextPreview,
          approvalMessage: this.toolExecutor.getPendingApprovalSummary(),
          approvalState: {
            messages: cloneMessages(messages),
            contextPreview,
          },
        };
      }
    }

    return {
      status: "needsContinuation",
      contextPreview,
      continuationMessage: `Достигнут лимит ${maxIterations} итераций. Можно продолжить без потери прогресса.`,
      continuationState: {
        messages: cloneMessages(messages),
        contextPreview,
      },
    };
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
          "File changes may be staged for user approval before they are applied.",
          "Do not assume staged changes are already applied until a later system message confirms approval.",
          "Avoid destructive or risky actions unless they are clearly necessary.",
          "After applying a change you may receive a system or tool message starting with '[Memory of past similar changes]'.",
          "Treat that block as predicted failures from similar past diffs: read the stack traces, decide whether the current change has the same risk, and proactively patch the issue before running real tests.",
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

function normalizeIterationLimit(value) {
  return Math.max(1, Math.min(100, Number(value) || 1));
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages || []));
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
      .map((item) => {
        if (typeof item?.text === "string") {
          return item.text;
        }
        if (typeof item?.content === "string") {
          return item.content;
        }
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

module.exports = {
  AgentRuntime,
};
