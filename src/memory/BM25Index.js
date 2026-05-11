const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

class BM25Index {
  constructor({ k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    this.k1 = k1;
    this.b = b;
  }

  search(queryTokens, entries) {
    const documents = entries
      .map((entry) => ({
        entry,
        tokens: Array.isArray(entry.tokens) ? entry.tokens : [],
      }))
      .filter((doc) => doc.tokens.length > 0);

    if (documents.length === 0 || !Array.isArray(queryTokens) || queryTokens.length === 0) {
      return [];
    }

    const docLengths = documents.map((doc) => doc.tokens.length);
    const totalLength = docLengths.reduce((sum, len) => sum + len, 0);
    const avgDocLen = totalLength / docLengths.length;

    const documentFrequency = new Map();
    for (const doc of documents) {
      const unique = new Set(doc.tokens.map(toLower));
      for (const term of unique) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }

    const queryTermSet = [...new Set(queryTokens.map(toLower))];
    const totalDocs = documents.length;

    const results = [];
    for (let docIndex = 0; docIndex < documents.length; docIndex += 1) {
      const doc = documents[docIndex];
      const docLen = docLengths[docIndex];

      const termFrequency = new Map();
      for (const token of doc.tokens) {
        const term = toLower(token);
        termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
      }

      let score = 0;
      for (const term of queryTermSet) {
        const tf = termFrequency.get(term) || 0;
        if (tf === 0) {
          continue;
        }
        const df = documentFrequency.get(term) || 0;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const denom = tf + this.k1 * (1 - this.b + (this.b * docLen) / Math.max(1, avgDocLen));
        score += (idf * tf * (this.k1 + 1)) / denom;
      }

      if (score > 0) {
        results.push({ entry: doc.entry, score });
      }
    }

    results.sort((left, right) => right.score - left.score);
    return results;
  }
}

function toLower(value) {
  return String(value).toLowerCase();
}

module.exports = {
  BM25Index,
};
