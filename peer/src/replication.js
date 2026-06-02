import { fetchJson } from './http.js';

export class Replication {
  constructor(chord, storage, metrics, log) {
    this.chord = chord;
    this.storage = storage;
    this.metrics = metrics;
    this.log = log;
  }

  async replicateRecord(record) {
    const replica = this.chord.successor;
    if (!replica || replica.peerId === this.chord.self.peerId) return;
    try {
      this.metrics.message();
      await fetchJson(`${replica.url}/store-replica`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'data', record })
      });
      this.log(`Replicated record ${record.recordKey} to ${replica.peerId}`);
    } catch (error) {
      this.log(`WARN failed to replicate record ${record.recordKey} to ${replica.peerId}: ${error.message}`);
    }
  }

  async replicateTemperatureRecord(record) {
    const replica = this.chord.successor;
    if (!replica || replica.peerId === this.chord.self.peerId) return;
    try {
      this.metrics.message();
      await fetchJson(`${replica.url}/store-replica`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'temp-index', record })
      });
      this.log(`Replicated temperature index ${record.recordKey} to ${replica.peerId}`);
    } catch (error) {
      this.log(`WARN failed to replicate temperature index ${record.recordKey} to ${replica.peerId}: ${error.message}`);
    }
  }

  async replicatePhtNode(node) {
    const replica = this.chord.successor;
    if (!replica || replica.peerId === this.chord.self.peerId) return;
    try {
      this.metrics.message();
      await fetchJson(`${replica.url}/store-replica`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'pht', node })
      });
      this.log(`Replicated PHT prefix "${node.prefix || 'root'}" to ${replica.peerId}`);
    } catch (error) {
      this.log(`WARN failed to replicate PHT prefix "${node.prefix || 'root'}" to ${replica.peerId}: ${error.message}`);
    }
  }
}
