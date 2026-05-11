const path = require("path");

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "true",
  "false",
  "null",
  "none",
  "self",
]);

const JVM_LIKE_EXT = new Set([
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
]);
const C_LIKE_EXT = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".ts",
  ".tsx",
  ".cs",
  ".go",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".rs",
  ".swift",
]);
const HASH_COMMENT_EXT = new Set([".py", ".rb", ".sh", ".yml", ".yaml"]);

class DiffNormalizer {
  buildQuery(changes) {
    const tokens = [];
    const methodSet = new Set();
    const files = [];
    const hunks = [];

    for (const change of changes) {
      const filePath = change.path || "";
      files.push(filePath);
      const extension = path.extname(filePath).toLowerCase();
      const original = String(change.originalContent || "");
      const proposed = String(change.proposedContent || "");

      const diff = diffLines(original, proposed);
      hunks.push(formatUnifiedHunk(filePath, diff));

      for (const line of [...diff.added, ...diff.removed]) {
        const stripped = stripComment(line, extension);
        if (!stripped.trim()) {
          continue;
        }
        for (const token of tokenize(stripped)) {
          tokens.push(token);
        }
        for (const sig of extractMethodSignatures(stripped, extension)) {
          methodSet.add(sig);
        }
      }
    }

    return {
      files,
      tokens,
      methods: [...methodSet],
      rawDiff: hunks.join("\n\n"),
    };
  }
}

function diffLines(original, proposed) {
  const originalLines = original.split(/\r?\n/);
  const proposedLines = proposed.split(/\r?\n/);
  const originalCounts = countLines(originalLines);
  const proposedCounts = countLines(proposedLines);

  const added = [];
  const removed = [];

  for (const line of proposedLines) {
    if ((originalCounts.get(line) || 0) > 0) {
      originalCounts.set(line, originalCounts.get(line) - 1);
      continue;
    }
    added.push(line);
  }

  for (const line of originalLines) {
    if ((proposedCounts.get(line) || 0) > 0) {
      proposedCounts.set(line, proposedCounts.get(line) - 1);
      continue;
    }
    removed.push(line);
  }

  return { added, removed };
}

function countLines(lines) {
  const counts = new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return counts;
}

function formatUnifiedHunk(filePath, diff) {
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const line of diff.removed) {
    lines.push(`- ${line}`);
  }
  for (const line of diff.added) {
    lines.push(`+ ${line}`);
  }
  return lines.join("\n");
}

function tokenize(text) {
  const out = [];
  const re = /[A-Za-z_][\w$]*/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    if (raw.length < 2) {
      continue;
    }
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) {
      continue;
    }
    out.push(lower);
    for (const piece of splitIdentifier(raw)) {
      if (piece.length >= 2 && !STOPWORDS.has(piece)) {
        out.push(piece);
      }
    }
  }
  return out;
}

function splitIdentifier(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function stripComment(line, extension) {
  if (JVM_LIKE_EXT.has(extension) || C_LIKE_EXT.has(extension)) {
    let cleaned = line.replace(/\/\/.*$/, "");
    cleaned = cleaned.replace(/\/\*.*?\*\//g, "");
    return cleaned;
  }
  if (HASH_COMMENT_EXT.has(extension)) {
    return line.replace(/#.*$/, "");
  }
  return line;
}

function extractMethodSignatures(line, extension) {
  const sigs = [];

  if (JVM_LIKE_EXT.has(extension) || extension === ".cs") {
    const re =
      /\b(?:public|protected|private|internal|static|final|abstract|synchronized|default|override|virtual|sealed|open|fun)\s+(?:[\w<>,\[\]\s.?]+?\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      sigs.push(`${match[1]}(${paramCount(match[2])})`);
    }
  } else if (
    extension === ".ts" ||
    extension === ".tsx" ||
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs" ||
    extension === ".mts" ||
    extension === ".cts"
  ) {
    const patterns = [
      /\bfunction\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g,
      /\b([A-Za-z_]\w*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g,
      /\b([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[1];
        if (
          name === "if" ||
          name === "for" ||
          name === "while" ||
          name === "switch" ||
          name === "catch" ||
          name === "return"
        ) {
          continue;
        }
        sigs.push(`${name}(${paramCount(match[2])})`);
      }
    }
  } else if (extension === ".py") {
    const re = /\bdef\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      sigs.push(`${match[1]}(${paramCount(match[2])})`);
    }
  } else if (extension === ".go") {
    const re = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      sigs.push(`${match[1]}(${paramCount(match[2])})`);
    }
  }

  return sigs;
}

function paramCount(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) {
    return "0p";
  }
  return `${cleaned.split(",").filter(Boolean).length}p`;
}

module.exports = {
  DiffNormalizer,
};
