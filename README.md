# AI Agent Assistant for VS Code

Расширение поднимает в VS Code отдельную chat-панель в стиле Copilot и работает как агент:

- автоматически собирает контекст активного файла;
- подтягивает локально разрешенные импорты;
- ищет связанные тесты по имени класса/файла;
- отправляет контекст и пользовательский запрос в OpenRouter;
- исполняет tool/actions, которые модель запросила: чтение файлов, запись файлов, поиск по workspace, запуск shell-команд и bash-скриптов.

## Что уже реализовано

- `WebviewViewProvider` в отдельном activity bar контейнере `Agent`
- хранение OpenRouter API key в `VS Code Secret Storage`
- agent loop через OpenRouter tool calling
- настраиваемый лимит итераций с паузой и продолжением без потери прогресса
- сборка prompt из:
  - активного файла
  - выделения в активном файле
  - локальных импортированных файлов
  - связанных тестов
  - пользовательского запроса
- инструменты агента:
  - `read_file`
  - `list_workspace_files`
  - `search_workspace`
  - `write_file`
  - `replace_active_file`
  - `run_shell_command`
  - `run_bash_script`
  - `read_terminal_output`
- отдельные визуальные блоки в чате для shell/bash команд и их вывода

## Ограничения текущей версии

- Разрешение импортов лучше всего работает для JS/TS и локальных путей. Для других языков используются эвристики по имени файла/класса.
- `read_terminal_output` читает вывод только тех shell/bash процессов, которые агент запускал сам. VS Code API не дает надежно читать произвольный вывод пользовательского integrated terminal.
- Редактирование файлов сейчас идет через полную перезапись содержимого файла.

## Быстрый старт

1. Откройте эту папку в VS Code.
2. Нажмите `F5`, чтобы запустить Extension Development Host.
3. Выполните команду `AI Agent: Set OpenRouter API Key`.
4. Откройте файл с классом.
5. Перейдите в activity bar `Agent` и отправьте запрос.

## Настройки

- `aiAgentAssistant.openRouter.model`
- `aiAgentAssistant.openRouter.baseUrl`
- `aiAgentAssistant.openRouter.requestTimeoutMs`
- `aiAgentAssistant.context.maxImportedFiles`
- `aiAgentAssistant.context.maxTests`
- `aiAgentAssistant.context.maxFileChars`
- `aiAgentAssistant.agent.maxIterations`
- `aiAgentAssistant.execution.requireConfirmation`
- `aiAgentAssistant.execution.commandTimeoutMs`

## Валидация

```bash
npm run validate
```

## Идеи для следующего шага

- streaming ответов в webview;
- diff-preview вместо слепой записи файлов;
- более точное разрешение импортов через language servers/AST;
- поддержка нескольких рабочих директорий и длинных диалогов с суммаризацией;
- отдельный approval flow для file writes и destructive commands.
