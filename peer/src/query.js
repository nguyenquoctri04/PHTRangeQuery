import { createQueryMetrics } from './metrics.js';
import { fetchJson } from './http.js';
import { hashId } from './hash.js';

export class QueryEngine {
  constructor({ chord, storage, pht, metrics, log, allPeers }) {
    this.chord = chord;
    this.storage = storage;
    this.pht = pht;
    this.metrics = metrics;
    this.log = log;
    this.allPeers = allPeers;
  }

  async naiveDhtRangeScan(min, max) {
    this.metrics.query();
    const q = createQueryMetrics('naive-dht-distributed-range-scan', min, max);
    const results = [];

    for (const peer of this.allPeers) {
      q.contact(peer.peerId);
      q.message(2);
      q.route([this.chord.self.peerId, peer.peerId]);
      q.hop(1);

      if (peer.peerId === this.chord.self.peerId) {
        results.push(...this.storage.scanRange(min, max, false));
        continue;
      }

      try {
        this.metrics.message();
        const response = await fetchJson(`${peer.url}/local/scan?min=${min}&max=${max}`);
        results.push(...response.results);
      } catch (error) {
        this.log(`WARN naive scan failed contacting ${peer.peerId}: ${error.message}`);
      }
    }

    return q.finish(deduplicate(results), []);
  }

  async phtRangeQuery(min, max) {
    this.metrics.query();
    const q = createQueryMetrics('pht-optimized-range-query', min, max);
    const { records, coveringPrefixes, theoreticalCover } = await this.pht.rangeQuery(min, max, q);
    const output = q.finish(deduplicate(records), coveringPrefixes);
    output.theoreticalCoveringPrefixes = theoreticalCover;
    return output;
  }

  async individualPointLookups(min, max) {
    this.metrics.query();
    const q = createQueryMetrics('dht-individual-point-lookups', min, max);
    const results = [];
    const pointKeys = [];

    for (let temperature = min; temperature <= max; temperature += 1) {
      const pointKey = `temp:${temperature}`;
      pointKeys.push(pointKey);
      const owner = await this.chord.findSuccessor(hashId(pointKey));
      q.contact(owner.node.peerId);
      q.route(owner.routingPath);
      q.hop(owner.routingPath.length);
      q.message(2);

      if (owner.node.peerId === this.chord.self.peerId) {
        results.push(...this.storage.getTemperatureRecords(temperature, false));
        continue;
      }

      try {
        this.metrics.message();
        const response = await fetchJson(`${owner.node.url}/temperature-index/lookup?temperature=${temperature}`);
        results.push(...response.results);
      } catch (error) {
        this.log(`WARN point lookup failed for temp=${temperature} at ${owner.node.peerId}: ${error.message}`);
      }
    }

    const output = q.finish(deduplicate(results), []);
    output.pointLookups = pointKeys.length;
    output.pointKeys = pointKeys;
    return output;
  }

  async compare(min, max) {
    const pointLookups = await this.individualPointLookups(min, max);
    const pht = await this.phtRangeQuery(min, max);
    return {
      min,
      max,
      pointLookups,
      pht,
      improvement: {
        peersContactedReducedBy: pointLookups.peersContacted - pht.peersContacted,
        messagesReducedBy: pointLookups.messagesSent - pht.messagesSent,
        latencyReducedByMs: pointLookups.latencyMs - pht.latencyMs
      }
    };
  }
}

function deduplicate(records) {
  const seen = new Set();
  const output = [];
  for (const record of records) {
    if (seen.has(record.recordKey)) continue;
    seen.add(record.recordKey);
    output.push(record);
  }
  return output.sort((a, b) => a.temperature - b.temperature || a.id - b.id);
}
