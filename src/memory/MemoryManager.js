const vscode = require("vscode");
const { DiffNormalizer } = require("./DiffNormalizer");
const { BM25Index } = require("./BM25Index");
const { MemoryStore } = require("./MemoryStore");
const { StackTraceParser } = require("./StackTraceParser");
const { JavaEnricher } = require("./JavaEnricher");
const { BytecodeFingerprint } = require("./BytecodeFingerprint");
const { Reranker, DEFAULT_WEIGHTS } = require("./Reranker");

const MAX_RAW_DIFF_CHARS = 4096;
const MAX_PENDING_QUERIES = 5;
const MAX_STORED_TOKENS = 600;
const MAX_STORED_METHODS = 60;
const MAX_STORED_CALLS = 60;
const MAX_STORED_NGRAMS = 400;

class MemoryManager {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.store = new MemoryStore(outputChannel);
    this.normalizer = new DiffNormalizer();
    this.index = new BM25Index();
    this.parser = new StackTraceParser();
    this.javaEnricher = new JavaEnricher(outputChannel);
    this.bytecodeFingerprint = new BytecodeFingerprint(outputChannel);
    this.pendingQueries = [];
    this.nextQueryId = 1;
  }

  isEnabled() {
    return Boolean(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.enabled", true)
    );
  }

  getTopK() {
    const configured = Number(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.topK", 3)
    );
    if (!Number.isFinite(configured) || configured < 1) {
      return 3;
    }
    return Math.min(10, Math.max(1, Math.round(configured)));
  }

  isJavaEnrichmentEnabled() {
    return Boolean(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.java.enabled", true)
    );
  }

  isRerankEnabled() {
    return Boolean(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.rerank.enabled", true)
    );
  }

  getRerankerSettings() {
    const config = vscode.workspace.getConfiguration("aiAgentAssistant");
    const topN = Number(config.get("memory.rerank.topN", 50)) || 50;
    const weights = {
      bm25: numberOr(config.get("memory.rerank.weights.bm25"), DEFAULT_WEIGHTS.bm25),
      methods: numberOr(
        config.get("memory.rerank.weights.methods"),
        DEFAULT_WEIGHTS.methods
      ),
      calls: numberOr(
        config.get("memory.rerank.weights.calls"),
        DEFAULT_WEIGHTS.calls
      ),
      bytecode: numberOr(
        config.get("memory.rerank.weights.bytecode"),
        DEFAULT_WEIGHTS.bytecode
      ),
    };
    return { topN, weights };
  }

  invalidate() {
    this.store.invalidate();
  }

  clearPending() {
    this.pendingQueries = [];
  }

  async recordPendingApply(changes) {
    const enabled = this.isEnabled();
    this.outputChannel?.appendLine(
      `[memory] recordPendingApply: enabled=${enabled} changes=${changes?.length ?? 0}`
    );
    if (!enabled || !Array.isArray(changes) || changes.length === 0) {
      return { queryId: null, predictions: [] };
    }

    const query = await this.buildEnrichedQuery(changes);
    const queryId = `q_${this.nextQueryId++}`;
    const createdAt = new Date().toISOString();

    if (this.pendingQueries.length >= MAX_PENDING_QUERIES) {
      this.pendingQueries.shift();
    }
    this.pendingQueries.push({ id: queryId, query, createdAt });
    this.outputChannel?.appendLine(
      `[memory] pendingQuery created id=${queryId} files=${(query.files || []).join(",")} tokens=${query.tokens?.length || 0} methods=${query.methods?.length || 0} callers=${query.callers?.length || 0} callees=${query.callees?.length || 0} bytecodeNgrams=${query.bytecode?.ngrams?.length || 0}`
    );

    const entries = await this.store.getEntries();
    const withValue = entries.filter((entry) => entry?.value);
    const topK = this.getTopK();
    this.outputChannel?.appendLine(
      `[memory] lookup: storedEntries=${entries.length} withValue=${withValue.length} topK=${topK}`
    );

    const bm25 = this.index.search(query.tokens, withValue);
    let ranked;
    if (this.isRerankEnabled() && bm25.length > 0) {
      const { topN, weights } = this.getRerankerSettings();
      const reranker = new Reranker({ topN, weights });
      ranked = reranker.rerank({ query, bm25Results: bm25, topK });
    } else {
      ranked = bm25.slice(0, topK).map((result) => ({
        entry: result.entry,
        score: result.score,
        components: { bm25Raw: result.score },
      }));
    }

    const predictions = ranked.map((result) => ({
      score: round(result.score),
      components: result.components,
      files: result.entry.files || [],
      createdAt: result.entry.createdAt || null,
      methods: result.entry.methods || [],
      callers: result.entry.callGraph?.callers || [],
      callees: result.entry.callGraph?.callees || [],
      value: result.entry.value || null,
    }));

    return { queryId, predictions, query };
  }

  async buildEnrichedQuery(changes) {
    const base = this.normalizer.buildQuery(changes);
    const methodSet = new Set(base.methods);
    const result = {
      files: base.files,
      tokens: base.tokens,
      methods: [],
      callers: [],
      callees: [],
      bytecode: null,
      rawDiff: base.rawDiff,
    };

    if (this.isJavaEnrichmentEnabled() && this.javaEnricher.isAvailable()) {
      try {
        const enriched = await this.javaEnricher.enrichChanges(changes);
        for (const method of enriched.affectedMethods) {
          if (method.fqn) {
            methodSet.add(method.fqn);
          }
          if (method.signature) {
            methodSet.add(method.signature);
          }
        }
        result.callers = enriched.callers || [];
        result.callees = enriched.callees || [];

        try {
          const fingerprint = await this.bytecodeFingerprint.build({
            affectedMethods: enriched.affectedMethods,
          });
          if (fingerprint?.ngrams?.length) {
            result.bytecode = { ngrams: fingerprint.ngrams };
          }
        } catch (error) {
          this.outputChannel?.appendLine(
            `[memory] bytecode fingerprint failed: ${error?.message || error}`
          );
        }
      } catch (error) {
        this.outputChannel?.appendLine(
          `[memory] java enrichment failed: ${error?.message || error}`
        );
      }
    }

    result.methods = [...methodSet];
    return result;
  }

  buildPredictionPromptText(predictions) {
    if (!Array.isArray(predictions) || predictions.length === 0) {
      return "";
    }

    const lines = [
      "[Memory of past similar changes]",
      "Найдены прошлые diff-ы, лексически похожие на только что применённый. Учти возможные падения тестов и поправь код, если применимо.",
      "",
    ];

    predictions.forEach((prediction, index) => {
      const components = prediction.components || {};
      const componentParts = [];
      if (components.bm25 !== undefined) componentParts.push(`bm25=${components.bm25}`);
      if (components.methods !== undefined) componentParts.push(`methods=${components.methods}`);
      if (components.calls !== undefined) componentParts.push(`calls=${components.calls}`);
      if (components.bytecode !== undefined) componentParts.push(`bytecode=${components.bytecode}`);
      const componentSuffix = componentParts.length ? ` (${componentParts.join(", ")})` : "";
      const head = `${index + 1}. score=${prediction.score}${componentSuffix} • файлы: ${(prediction.files || []).join(", ") || "—"}`;
      lines.push(head);

      const failures = prediction.value?.failures || [];
      if (failures.length === 0) {
        lines.push("   Прошлый запуск: тесты прошли.");
      } else {
        const topFailures = failures.slice(0, 3);
        for (const failure of topFailures) {
          lines.push(
            `   - ${failure.exception}${failure.message ? `: ${truncate(failure.message, 200)}` : ""}`
          );
          for (const frame of failure.frames.slice(0, 3)) {
            lines.push(
              `       at ${frame.class}.${frame.method}(${frame.location})`
            );
          }
        }
        if (failures.length > topFailures.length) {
          lines.push(
            `   ... ещё ${failures.length - topFailures.length} падений.`
          );
        }
      }
      lines.push("");
    });

    return lines.join("\n").trim();
  }

  async maybeRecordTestOutput({ commandText, stdout, stderr }) {
    const enabled = this.isEnabled();
    const pendingCount = this.pendingQueries.length;
    const text = `${stdout || ""}\n${stderr || ""}`;
    const isCmd = this.parser.isTestCommand(commandText);
    const looksLike = this.parser.outputLooksLikeTests(text);
    this.outputChannel?.appendLine(
      `[memory] maybeRecordTestOutput: enabled=${enabled} pending=${pendingCount} isTestCmd=${isCmd} outputLooksLikeTests=${looksLike} command="${String(commandText || "").slice(0, 80)}"`
    );

    if (!enabled || pendingCount === 0) {
      return { recorded: false };
    }

    if (!isCmd && !looksLike) {
      return { recorded: false };
    }

    const parsed = this.parser.parse(text);
    const value = {
      failures: parsed.failures,
      success: parsed.success || parsed.failures.length === 0,
      commandText: String(commandText || ""),
      capturedAt: new Date().toISOString(),
    };
    this.outputChannel?.appendLine(
      `[memory] parsed test output: failures=${parsed.failures.length} success=${value.success}`
    );

    const queries = this.pendingQueries.splice(0, this.pendingQueries.length);
    for (const item of queries) {
      const id = `rec_${item.id}_${Date.now()}`;
      await this.store.addEntry({
        id,
        createdAt: item.createdAt,
        files: item.query.files,
        tokens: cap(item.query.tokens, MAX_STORED_TOKENS),
        methods: cap(item.query.methods, MAX_STORED_METHODS),
        callGraph: {
          callers: cap(item.query.callers, MAX_STORED_CALLS),
          callees: cap(item.query.callees, MAX_STORED_CALLS),
        },
        bytecode: item.query.bytecode
          ? { ngrams: cap(item.query.bytecode.ngrams, MAX_STORED_NGRAMS) }
          : null,
        rawDiff: truncate(item.query.rawDiff, MAX_RAW_DIFF_CHARS),
        value,
      });
      this.outputChannel?.appendLine(`[memory] entry saved id=${id}`);
    }

    return {
      recorded: true,
      count: queries.length,
      value,
      summary: this.parser.summarize(parsed.failures),
    };
  }
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function truncate(value, max) {
  const text = String(value || "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function cap(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }
  if (values.length <= limit) {
    return values.slice();
  }
  return values.slice(0, limit);
}

function numberOr(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  return num;
}

module.exports = {
  MemoryManager,
};
