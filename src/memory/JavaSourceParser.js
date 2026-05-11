const PACKAGE_RE = /\bpackage\s+([\w.]+)\s*;/;

const STATEMENT_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "synchronized",
  "try",
  "do",
  "return",
  "new",
  "throw",
  "else",
  "assert",
  "case",
]);

const MODIFIER_TOKENS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "default",
  "native",
  "strictfp",
  "transient",
  "volatile",
  "sealed",
  "non-sealed",
]);

const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record"]);

class JavaSourceParser {
  parse(source) {
    const stripped = stripCommentsAndStrings(String(source || ""));
    const packageMatch = stripped.match(PACKAGE_RE);
    const packageName = packageMatch ? packageMatch[1] : "";
    const types = [];
    scanTypes(stripped, source, 0, stripped.length, packageName, types);
    return {
      packageName,
      types,
    };
  }
}

function scanTypes(stripped, source, start, end, namespace, sink) {
  const headerRe = /\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/g;
  headerRe.lastIndex = start;
  let match;
  while ((match = headerRe.exec(stripped)) !== null && match.index < end) {
    const headerEnd = headerRe.lastIndex;
    const openBrace = findChar(stripped, "{", headerEnd, end);
    if (openBrace === -1) {
      break;
    }
    const closeBrace = matchBrace(stripped, openBrace, end);
    if (closeBrace === -1) {
      break;
    }
    const name = match[2];
    const fqn = namespace ? `${namespace}.${name}` : name;
    const methods = scanMethods(stripped, source, openBrace + 1, closeBrace, fqn);
    sink.push({
      name,
      fqn,
      kind: match[1],
      headerStart: match.index,
      bodyStart: openBrace + 1,
      bodyEnd: closeBrace,
      methods,
    });
    scanTypes(stripped, source, openBrace + 1, closeBrace, fqn, sink);
    headerRe.lastIndex = closeBrace + 1;
  }
}

function scanMethods(stripped, source, start, end, ownerFqn) {
  const skipIntervals = findNestedTypeIntervals(stripped, start, end);
  const methods = [];
  let cursor = start;

  while (cursor < end) {
    const insideSkip = findContaining(skipIntervals, cursor);
    if (insideSkip) {
      cursor = insideSkip.end + 1;
      continue;
    }

    const methodMatch = matchMethodHeader(stripped, cursor, end);
    if (methodMatch) {
      const close = matchBrace(stripped, methodMatch.openBrace, end);
      if (close !== -1) {
        const name = methodMatch.name;
        const params = methodMatch.params;
        methods.push({
          name,
          paramText: params,
          signature: `${name}(${paramSignature(params)})`,
          fqn: `${ownerFqn}#${name}(${paramSignature(params)})`,
          headerStart: methodMatch.headerStart,
          headerEnd: methodMatch.openBrace,
          bodyStart: methodMatch.openBrace + 1,
          bodyEnd: close,
          headerText: source.slice(methodMatch.headerStart, methodMatch.openBrace),
          bodyText: source.slice(methodMatch.openBrace + 1, close),
          ownerFqn,
        });
        cursor = close + 1;
        continue;
      }
    }
    cursor++;
  }

  return methods;
}

function findNestedTypeIntervals(stripped, start, end) {
  const intervals = [];
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/g;
  re.lastIndex = start;
  let match;
  while ((match = re.exec(stripped)) !== null && match.index < end) {
    const open = findChar(stripped, "{", re.lastIndex, end);
    if (open === -1) {
      break;
    }
    const close = matchBrace(stripped, open, end);
    if (close === -1) {
      break;
    }
    intervals.push({ start: match.index, end: close });
    re.lastIndex = close + 1;
  }
  return intervals;
}

function findContaining(intervals, position) {
  for (const interval of intervals) {
    if (position >= interval.start && position <= interval.end) {
      return interval;
    }
  }
  return null;
}

function matchMethodHeader(stripped, start, end) {
  let i = skipWhitespace(stripped, start, end);
  if (i >= end) {
    return null;
  }

  const headerStart = i;
  const tokens = [];
  while (i < end) {
    const tokenInfo = readJavaToken(stripped, i, end);
    if (!tokenInfo) {
      return null;
    }
    if (tokenInfo.kind === "punct" && tokenInfo.value === "(") {
      break;
    }
    if (tokenInfo.kind === "identifier" && TYPE_KEYWORDS.has(tokenInfo.value)) {
      return null;
    }
    tokens.push(tokenInfo);
    i = tokenInfo.next;
    if (i - headerStart > 800) {
      return null;
    }
  }

  if (i >= end) {
    return null;
  }

  let lastIdentIndex = -1;
  for (let k = tokens.length - 1; k >= 0; k--) {
    if (tokens[k].kind === "identifier") {
      lastIdentIndex = k;
      break;
    }
  }
  if (lastIdentIndex === -1) {
    return null;
  }

  const lastIdent = tokens[lastIdentIndex];
  if (STATEMENT_KEYWORDS.has(lastIdent.value)) {
    return null;
  }
  if (MODIFIER_TOKENS.has(lastIdent.value)) {
    return null;
  }

  const beforeName = tokens.slice(0, lastIdentIndex);
  const hasContext = beforeName.some(
    (t) => t.kind === "identifier" || t.kind === "annotation"
  );
  if (!hasContext) {
    return null;
  }

  const parenStart = i;
  const parenEnd = matchPair(stripped, parenStart, "(", ")", end);
  if (parenEnd === -1) {
    return null;
  }

  let afterParen = skipWhitespace(stripped, parenEnd + 1, end);
  if (afterParen < end && startsWithKeyword(stripped, afterParen, "throws")) {
    while (
      afterParen < end &&
      stripped[afterParen] !== "{" &&
      stripped[afterParen] !== ";"
    ) {
      afterParen++;
    }
  }

  if (afterParen >= end) {
    return null;
  }
  if (stripped[afterParen] === ";") {
    return null;
  }
  if (stripped[afterParen] !== "{") {
    return null;
  }

  return {
    headerStart,
    name: lastIdent.value,
    params: stripped.slice(parenStart + 1, parenEnd),
    openBrace: afterParen,
  };
}

function startsWithKeyword(text, position, keyword) {
  if (!text.startsWith(keyword, position)) {
    return false;
  }
  const next = text[position + keyword.length];
  return next === undefined || /\s/.test(next);
}

function readJavaToken(text, start, end) {
  let i = skipWhitespace(text, start, end);
  if (i >= end) {
    return null;
  }
  const ch = text[i];
  if (isIdentStart(ch)) {
    let j = i + 1;
    while (j < end && isIdentPart(text[j])) {
      j++;
    }
    return { kind: "identifier", value: text.slice(i, j), next: j };
  }
  if (
    ch === "<" ||
    ch === ">" ||
    ch === "[" ||
    ch === "]" ||
    ch === "," ||
    ch === "." ||
    ch === "?"
  ) {
    return { kind: "punct", value: ch, next: i + 1 };
  }
  if (ch === "(" || ch === ")") {
    return { kind: "punct", value: ch, next: i + 1 };
  }
  if (ch === "@") {
    let j = i + 1;
    j = skipWhitespace(text, j, end);
    while (j < end && isIdentPart(text[j])) {
      j++;
    }
    j = skipWhitespace(text, j, end);
    if (j < end && text[j] === "(") {
      const close = matchPair(text, j, "(", ")", end);
      if (close !== -1) {
        j = close + 1;
      }
    }
    return { kind: "annotation", value: text.slice(i, j), next: j };
  }
  return null;
}

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function skipWhitespace(text, start, end) {
  let i = start;
  while (i < end && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

function findChar(text, ch, start, end) {
  for (let i = start; i < end; i++) {
    if (text[i] === ch) {
      return i;
    }
  }
  return -1;
}

function matchBrace(text, openIndex, end) {
  return matchPair(text, openIndex, "{", "}", end);
}

function matchPair(text, openIndex, open, close, end) {
  let depth = 0;
  for (let i = openIndex; i < end; i++) {
    const ch = text[i];
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function paramSignature(rawParams) {
  const cleaned = String(rawParams || "").trim();
  if (!cleaned) {
    return "0p";
  }
  let depth = 0;
  let count = 1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "<" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === ">" || ch === ")" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      count++;
    }
  }
  return `${count}p`;
}

function stripCommentsAndStrings(source) {
  const out = new Array(source.length);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out[i] = source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }

    if (ch === '"') {
      out[i] = '"';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        out[i] = source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out[i] = '"';
        i++;
      }
      continue;
    }

    if (ch === "'") {
      out[i] = "'";
      i++;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\" && i + 1 < source.length) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        out[i] = " ";
        i++;
      }
      if (i < source.length) {
        out[i] = "'";
        i++;
      }
      continue;
    }

    out[i] = ch;
    i++;
  }
  return out.join("");
}

function offsetToLine(source, offset) {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === "\n") {
      line++;
    }
  }
  return line;
}

function findEnclosingMethod(parsed, source, lineNumber) {
  let best = null;
  for (const type of parsed.types) {
    for (const method of type.methods) {
      const startLine = offsetToLine(source, method.headerStart);
      const endLine = offsetToLine(source, method.bodyEnd);
      if (lineNumber >= startLine && lineNumber <= endLine) {
        if (
          !best ||
          endLine - startLine < best.endLine - best.startLine
        ) {
          best = { method, type, startLine, endLine };
        }
      }
    }
  }
  return best;
}

function findEnclosingType(parsed, source, lineNumber) {
  let best = null;
  for (const type of parsed.types) {
    const startLine = offsetToLine(source, type.headerStart);
    const endLine = offsetToLine(source, type.bodyEnd);
    if (lineNumber >= startLine && lineNumber <= endLine) {
      if (!best || endLine - startLine < best.endLine - best.startLine) {
        best = { type, startLine, endLine };
      }
    }
  }
  return best;
}

module.exports = {
  JavaSourceParser,
  stripCommentsAndStrings,
  offsetToLine,
  findEnclosingMethod,
  findEnclosingType,
};
