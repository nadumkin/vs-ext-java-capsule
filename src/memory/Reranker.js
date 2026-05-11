const DEFAULT_WEIGHTS = {
  bm25: 1.0,
  methods: 1.0,
  calls: 0.7,
  bytecode: 0.5,
};

const DEFAULT_TOP_N = 50;

class Reranker {
  constructor({ weights = DEFAULT_WEIGHTS, topN = DEFAULT_TOP_N } = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
    this.topN = Math.max(1, Number(topN) || DEFAULT_TOP_N);
  }

  rerank({ query, bm25Results, topK }) {
    if (!Array.isArray(bm25Results) || bm25Results.length === 0) {
      return [];
    }
    const truncated = bm25Results.slice(0, this.topN);
    const maxBm25 = truncated[0]?.score || 1;

    const queryMethods = setOf(query?.methods);
    const queryCalls = setOf([
      ...(query?.callers || []),
      ...(query?.callees || []),
    ]);
    const queryBytecode = setOf(query?.bytecode?.ngrams);

    const ranked = truncated.map((candidate) => {
      const entry = candidate.entry;
      const normBm25 = maxBm25 > 0 ? candidate.score / maxBm25 : 0;
      const simMethods = jaccard(queryMethods, setOf(entry.methods));
      const simCalls = jaccard(
        queryCalls,
        setOf([
          ...(entry.callGraph?.callers || []),
          ...(entry.callGraph?.callees || []),
        ])
      );
      const simBytecode = jaccard(
        queryBytecode,
        setOf(entry.bytecode?.ngrams)
      );

      const final =
        this.weights.bm25 * normBm25 +
        this.weights.methods * simMethods +
        this.weights.calls * simCalls +
        this.weights.bytecode * simBytecode;

      return {
        entry,
        score: final,
        components: {
          bm25: round(normBm25),
          methods: round(simMethods),
          calls: round(simCalls),
          bytecode: round(simBytecode),
          bm25Raw: round(candidate.score),
        },
      };
    });

    ranked.sort((left, right) => right.score - left.score);
    return ranked.slice(0, Math.max(1, Number(topK) || ranked.length));
  }
}

function setOf(values) {
  if (!Array.isArray(values)) {
    return new Set();
  }
  const set = new Set();
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    set.add(String(value));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

module.exports = {
  Reranker,
  DEFAULT_WEIGHTS,
};
