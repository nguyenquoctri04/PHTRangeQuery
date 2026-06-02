import { fetchJson } from './http.js';
import { M, RING_SIZE, hashId, inOpenClosed, inOpenOpen, normalizeId } from './hash.js';

export class ChordNode {
  constructor({ peerId, url, bootstrapUrl, metrics, log }) {
    this.self = {
      peerId,
      hashId: hashId(peerId),
      url
    };
    this.bootstrapUrl = bootstrapUrl;
    this.metrics = metrics;
    this.log = log;
    this.successor = this.self;
    this.predecessor = null;
    this.fingerTable = this.initialFingerTable(this.self);
    this.knownPeers = [this.self];
  }

  initialFingerTable(node) {
    return Array.from({ length: M }, (_, index) => ({
      start: normalizeId(this.self.hashId + 2 ** index),
      node
    }));
  }

  async join() {
    this.log(`Join started hash=${this.self.hashId}`);
    const registered = await fetchJson(`${this.bootstrapUrl}/register`, {
      method: 'POST',
      body: JSON.stringify(this.self)
    });
    this.metrics.message();
    this.knownPeers = registered.peers || [this.self];

    const introduced = await fetchJson(`${this.bootstrapUrl}/find-successor?id=${this.self.hashId}`);
    this.metrics.message();
    if (introduced.successor) {
      this.successor = introduced.successor.peerId === this.self.peerId ? this.self : introduced.successor;
    }

    this.initializeFromIntroducerPeers();
    await this.initFingerTable();
    await this.notifySuccessor();
    this.log(`Join complete successor=${this.successor.peerId}`);
  }

  initializeFromIntroducerPeers() {
    const ring = this.knownPeers
      .filter((peer) => peer.peerId && peer.url)
      .sort((a, b) => a.hashId - b.hashId);
    const index = ring.findIndex((peer) => peer.peerId === this.self.peerId);
    if (index < 0 || ring.length === 1) return;
    this.successor = ring[(index + 1) % ring.length];
    this.predecessor = ring[(index - 1 + ring.length) % ring.length];
  }

  async initFingerTable() {
    for (let index = 0; index < M; index += 1) {
      const result = await this.findSuccessor(this.fingerTable[index].start);
      this.fingerTable[index].node = result.node;
    }
  }

  closestPrecedingNode(id) {
    for (let index = M - 1; index >= 0; index -= 1) {
      const candidate = this.fingerTable[index]?.node;
      if (candidate && candidate.peerId !== this.self.peerId && inOpenOpen(candidate.hashId, this.self.hashId, id)) {
        return candidate;
      }
    }
    return this.self;
  }

  async findSuccessor(id, routingPath = []) {
    id = normalizeId(id);
    routingPath = [...routingPath, this.self.peerId];

    if (this.successor.peerId === this.self.peerId || inOpenClosed(id, this.self.hashId, this.successor.hashId)) {
      return {
        node: this.successor,
        routingPath: [...routingPath, this.successor.peerId],
        hops: routingPath.length
      };
    }

    const next = this.closestPrecedingNode(id);
    if (next.peerId === this.self.peerId) {
      return {
        node: this.successor,
        routingPath: [...routingPath, this.successor.peerId],
        hops: routingPath.length
      };
    }

    try {
      this.metrics.message();
      const forwarded = await fetchJson(`${next.url}/find-successor?id=${id}&path=${encodeURIComponent(routingPath.join(','))}`);
      return {
        node: forwarded.node,
        routingPath: forwarded.routingPath,
        hops: forwarded.hops
      };
    } catch (error) {
      this.log(`WARN route via ${next.peerId} failed for id=${id}: ${error.message}`);
      return {
        node: this.successor,
        routingPath: [...routingPath, `${next.peerId}:failed`, this.successor.peerId],
        hops: routingPath.length + 1
      };
    }
  }

  async stabilize() {
    try {
      if (!this.successor || this.successor.peerId === this.self.peerId) {
        await this.refreshKnownPeersFromBootstrapForJoinOnly();
      }

      this.metrics.message();
      const response = await fetchJson(`${this.successor.url}/predecessor`);
      const x = response.predecessor;
      if (x && x.peerId !== this.self.peerId && inOpenOpen(x.hashId, this.self.hashId, this.successor.hashId)) {
        this.log(`stabilize update successor ${this.successor.peerId} -> ${x.peerId}`);
        this.successor = x;
      }
      await this.notifySuccessor();
      this.log(`stabilize successor=${this.successor.peerId} predecessor=${this.predecessor?.peerId || 'null'}`);
    } catch (error) {
      this.log(`WARN stabilize failed against ${this.successor?.peerId}: ${error.message}`);
      await this.repairSuccessorFromFingers();
    }
  }

  async notifySuccessor() {
    if (!this.successor || this.successor.peerId === this.self.peerId) return;
    try {
      this.metrics.message();
      await fetchJson(`${this.successor.url}/notify`, {
        method: 'POST',
        body: JSON.stringify({ node: this.self })
      });
    } catch (error) {
      this.log(`WARN notify ${this.successor.peerId} failed: ${error.message}`);
    }
  }

  notify(node) {
    if (!node || node.peerId === this.self.peerId) return false;
    if (!this.predecessor || inOpenOpen(node.hashId, this.predecessor.hashId, this.self.hashId)) {
      this.log(`notify accepted predecessor ${this.predecessor?.peerId || 'null'} -> ${node.peerId}`);
      this.predecessor = node;
      return true;
    }
    return false;
  }

  async fixFingers() {
    const index = Math.floor(Math.random() * M);
    const start = this.fingerTable[index].start;
    const result = await this.findSuccessor(start);
    this.fingerTable[index].node = result.node;
    this.log(`fix_fingers[${index}] start=${start} node=${result.node.peerId}`);
  }

  async refreshKnownPeersFromBootstrapForJoinOnly() {
    try {
      this.metrics.message();
      const response = await fetchJson(`${this.bootstrapUrl}/peers`);
      this.knownPeers = response.peers || this.knownPeers;
      this.initializeFromIntroducerPeers();
    } catch (error) {
      this.log(`WARN bootstrap refresh failed: ${error.message}`);
    }
  }

  async repairSuccessorFromFingers() {
    const candidates = [
      ...this.fingerTable.map((finger) => finger.node),
      this.predecessor,
      ...this.knownPeers
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.peerId === this.self.peerId || candidate.peerId === this.successor?.peerId) continue;
      try {
        this.metrics.message();
        await fetchJson(`${candidate.url}/health`);
        this.successor = candidate;
        this.log(`failure recovery selected successor=${candidate.peerId}`);
        return;
      } catch {
        // try next candidate
      }
    }
    this.successor = this.self;
  }

  startMaintenance() {
    setInterval(() => this.stabilize(), 5000);
    setInterval(() => this.fixFingers().catch((error) => this.log(`WARN fix_fingers failed: ${error.message}`)), 10000);
  }

  info() {
    return {
      peerId: this.self.peerId,
      hashId: this.self.hashId,
      successor: this.successor,
      predecessor: this.predecessor,
      fingerTable: this.fingerTable
    };
  }
}

export { M, RING_SIZE, hashId };
