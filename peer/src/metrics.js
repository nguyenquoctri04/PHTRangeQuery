export class Metrics {
  constructor() {
    this.totalMessages = 0;
    this.totalQueries = 0;
  }

  message(count = 1) {
    this.totalMessages += count;
  }

  query() {
    this.totalQueries += 1;
  }

  snapshot(extra = {}) {
    return {
      totalMessages: this.totalMessages,
      totalQueries: this.totalQueries,
      ...extra
    };
  }
}

export function createQueryMetrics(queryType, min, max) {
  const started = Date.now();
  const peers = new Set();
  const routingPath = [];
  let messages = 0;
  let queryHops = 0;

  return {
    contact(peerId) {
      if (peerId) peers.add(peerId);
    },
    message(count = 1) {
      messages += count;
    },
    hop(count = 1) {
      queryHops += count;
    },
    route(items) {
      for (const item of items || []) routingPath.push(item);
    },
    finish(results, coveringPrefixes = []) {
      return {
        queryType,
        min,
        max,
        resultsCount: results.length,
        peersContacted: peers.size,
        messagesSent: messages,
        queryHops,
        routingPath,
        latencyMs: Date.now() - started,
        coveringPrefixes,
        results
      };
    }
  };
}
