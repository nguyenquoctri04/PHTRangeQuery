import { fetchJson } from './http.js';
import { hashId } from './hash.js';

export const MIN_TEMP = -20;
export const MAX_TEMP = 50;
export const TEMP_BITS = 7;
export const MAX_BUCKET_SIZE = 10;

export function tempToBinary(temp) {
  const shifted = Number(temp) + 20;
  if (!Number.isInteger(shifted) || shifted < 0 || shifted > 70) {
    throw new Error('temperature must be an integer from -20 to 50');
  }
  return shifted.toString(2).padStart(TEMP_BITS, '0');
}

export function binaryToTemp(bits) {
  return parseInt(bits, 2) - 20;
}

export function prefixKey(prefix) {
  return prefix === '' ? 'root' : prefix;
}

export function prefixHash(prefix) {
  return hashId(prefixKey(prefix));
}

export function prefixInterval(prefix) {
  const missing = TEMP_BITS - prefix.length;
  const start = parseInt((prefix || '').padEnd(TEMP_BITS, '0'), 2);
  const end = start + 2 ** missing - 1;
  return {
    shiftedStart: start,
    shiftedEnd: end,
    min: Math.max(MIN_TEMP, start - 20),
    max: Math.min(MAX_TEMP, end - 20)
  };
}

export function intervalOverlaps(prefix, min, max) {
  const interval = prefixInterval(prefix);
  return interval.max >= min && interval.min <= max;
}

export function intervalInside(prefix, min, max) {
  const interval = prefixInterval(prefix);
  return interval.min >= min && interval.max <= max;
}

export function computeCoveringPrefixes(min, max, prefix = '') {
  if (!intervalOverlaps(prefix, min, max)) return [];
  if (intervalInside(prefix, min, max) || prefix.length === TEMP_BITS) return [prefix];
  return [
    ...computeCoveringPrefixes(min, max, `${prefix}0`),
    ...computeCoveringPrefixes(min, max, `${prefix}1`)
  ];
}

export class PHT {
  constructor(chord, storage, replication, metrics, log) {
    this.chord = chord;
    this.storage = storage;
    this.replication = replication;
    this.metrics = metrics;
    this.log = log;
  }

  async ensureRoot() {
    const existing = await this.getNode('', { allowMissing: true });
    if (existing.node) return existing.node;
    const owner = await this.chord.findSuccessor(prefixHash(''));
    const root = {
      prefix: '',
      isLeaf: true,
      records: [],
      leftChild: null,
      rightChild: null,
      ownerPeer: owner.node.peerId
    };
    await this.storeNode(root);
    this.log(`Root PHT node created at ${owner.node.peerId}`);
    return root;
  }

  async insert(record) {
    await this.ensureRoot();
    const binaryKey = tempToBinary(record.temperature);
    await this.insertAtPrefix('', binaryKey, record);
  }

  async insertAtPrefix(prefix, binaryKey, record) {
    const { node } = await this.getNode(prefix, { allowMissing: true });
    if (!node) {
      const owner = await this.chord.findSuccessor(prefixHash(prefix));
      const created = this.withOwner({
        prefix,
        isLeaf: true,
        records: [record],
        leftChild: null,
        rightChild: null
      }, owner.node);
      await this.storeNode(created);
      return;
    }

    if (node.isLeaf) {
      if (!node.records.some((item) => item.recordKey === record.recordKey)) {
        node.records.push(record);
      }
      if (node.records.length > MAX_BUCKET_SIZE && prefix.length < TEMP_BITS) {
        await this.split(node);
      } else {
        await this.storeNode(node);
      }
      return;
    }

    const nextPrefix = prefix + binaryKey[prefix.length];
    await this.insertAtPrefix(nextPrefix, binaryKey, record);
  }

  async split(node) {
    const leftPrefix = `${node.prefix}0`;
    const rightPrefix = `${node.prefix}1`;
    const leftRecords = [];
    const rightRecords = [];

    for (const record of node.records) {
      const binaryKey = tempToBinary(record.temperature);
      if (binaryKey.startsWith(leftPrefix)) leftRecords.push(record);
      else rightRecords.push(record);
    }

    const leftOwner = await this.chord.findSuccessor(prefixHash(leftPrefix));
    const rightOwner = await this.chord.findSuccessor(prefixHash(rightPrefix));

    const leftNode = this.withOwner({
      prefix: leftPrefix,
      isLeaf: true,
      records: leftRecords,
      leftChild: null,
      rightChild: null
    }, leftOwner.node);

    const rightNode = this.withOwner({
      prefix: rightPrefix,
      isLeaf: true,
      records: rightRecords,
      leftChild: null,
      rightChild: null
    }, rightOwner.node);

    node.isLeaf = false;
    node.records = [];
    node.leftChild = leftPrefix;
    node.rightChild = rightPrefix;

    await this.storeNode(node);
    await this.storeNode(leftNode);
    await this.storeNode(rightNode);
    this.log(`Split "${node.prefix || 'root'}" -> "${leftPrefix}", "${rightPrefix}"`);

    if (leftRecords.length > MAX_BUCKET_SIZE && leftPrefix.length < TEMP_BITS) {
      await this.split(leftNode);
    }
    if (rightRecords.length > MAX_BUCKET_SIZE && rightPrefix.length < TEMP_BITS) {
      await this.split(rightNode);
    }
  }

  withOwner(node, owner) {
    return {
      ...node,
      ownerPeer: owner.peerId
    };
  }

  async storeNode(node) {
    const owner = await this.chord.findSuccessor(prefixHash(node.prefix));
    node.ownerPeer = owner.node.peerId;
    if (owner.node.peerId === this.chord.self.peerId) {
      this.storage.storePhtNode(node, false);
      await this.replication.replicatePhtNode(node);
      return;
    }
    this.metrics.message();
    await fetchJson(`${owner.node.url}/pht/store`, {
      method: 'POST',
      body: JSON.stringify({ node, replicate: true })
    });
  }

  async getNode(prefix, options = {}) {
    const owner = await this.chord.findSuccessor(prefixHash(prefix));
    if (owner.node.peerId === this.chord.self.peerId) {
      return {
        node: this.storage.getPhtNode(prefix),
        owner: owner.node,
        routingPath: owner.routingPath,
        fromReplica: false
      };
    }

    try {
      this.metrics.message();
      const response = await fetchJson(`${owner.node.url}/pht/lookup?prefix=${encodeURIComponent(prefix)}`);
      return {
        node: response.node,
        owner: owner.node,
        routingPath: owner.routingPath,
        fromReplica: false
      };
    } catch (error) {
      if (error.status === 404 && options.allowMissing) {
        return {
          node: null,
          owner: owner.node,
          routingPath: owner.routingPath,
          fromReplica: false
        };
      }
      const candidates = [
        this.chord.successor,
        ...this.chord.fingerTable.map((finger) => finger.node),
        ...this.chord.knownPeers
      ].filter(Boolean);
      const seen = new Set([owner.node.peerId]);
      for (const fallback of candidates) {
        if (seen.has(fallback.peerId)) continue;
        seen.add(fallback.peerId);
        try {
          this.log(`WARN primary ${owner.node.peerId} failed for PHT prefix "${prefix || 'root'}"; trying replica ${fallback.peerId}`);
          this.metrics.message();
          const response = await fetchJson(`${fallback.url}/pht/lookup?prefix=${encodeURIComponent(prefix)}&replica=true`);
          return {
            node: response.node,
            owner: fallback,
            routingPath: [...owner.routingPath, `${owner.node.peerId}:failed`, fallback.peerId],
            fromReplica: true
          };
        } catch {
          // try next replica candidate
        }
      }
      throw error;
    }
  }

  async rangeQuery(min, max, queryMetrics) {
    const theoreticalCover = computeCoveringPrefixes(min, max);
    const records = [];
    const coveringPrefixes = [];
    const contactedPeers = new Set();

    const visit = async (prefix) => {
      if (!intervalOverlaps(prefix, min, max)) return;
      const lookup = await this.getNode(prefix);
      queryMetrics.contact(lookup.owner.peerId);
      queryMetrics.route(lookup.routingPath);
      queryMetrics.hop(lookup.routingPath.length);
      if (!contactedPeers.has(lookup.owner.peerId)) {
        contactedPeers.add(lookup.owner.peerId);
        queryMetrics.message(2);
      }

      const node = lookup.node;
      if (!node) return;

      if (node.isLeaf) {
        coveringPrefixes.push(prefix);
        for (const record of node.records) {
          if (record.temperature >= min && record.temperature <= max) records.push(record);
        }
        return;
      }

      if (node.leftChild) await visit(node.leftChild);
      if (node.rightChild) await visit(node.rightChild);
    };

    await visit('');
    return {
      records,
      coveringPrefixes,
      theoreticalCover
    };
  }
}
