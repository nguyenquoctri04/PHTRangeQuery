import express from 'express';
import { ChordNode, hashId } from './chord.js';
import { JsonStorage } from './storage.js';
import { Metrics } from './metrics.js';
import { Replication } from './replication.js';
import { PHT, prefixHash } from './pht.js';
import { QueryEngine } from './query.js';
import { fetchJson } from './http.js';

const PORT = Number(process.env.PORT || 3000);
const peerId = process.env.PEER_ID || 'peer';
const selfUrl = process.env.SELF_URL || `http://${peerId}:${PORT}`;
const bootstrapUrl = process.env.BOOTSTRAP_URL || 'http://bootstrap-node:3000';
const peerList = (process.env.PEER_LIST || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [id, url] = item.split('=');
    return { peerId: id, hashId: hashId(id), url };
  });

function log(message) {
  console.log(`[${peerId}] ${message}`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const metrics = new Metrics();
const storage = new JsonStorage(peerId);
const chord = new ChordNode({ peerId, url: selfUrl, bootstrapUrl, metrics, log });
if (peerList.length) chord.knownPeers = peerList;
const replication = new Replication(chord, storage, metrics, log);
const pht = new PHT(chord, storage, replication, metrics, log);
const query = new QueryEngine({ chord, storage, pht, metrics, log, allPeers: peerList });

let joined = false;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', peerId, hashId: chord.self.hashId, joined });
});

app.post('/join', async (_req, res) => {
  try {
    await joinOnce();
    res.json({ ok: true, peer: chord.info() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/peer-info', (_req, res) => {
  res.json(chord.info());
});

app.get('/finger-table', (_req, res) => {
  res.json({ peerId, hashId: chord.self.hashId, fingerTable: chord.fingerTable });
});

app.get('/find-successor', async (req, res) => {
  try {
    const id = Number(req.query.id);
    const path = req.query.path ? String(req.query.path).split(',').filter(Boolean) : [];
    const result = await chord.findSuccessor(id, path);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/predecessor', (_req, res) => {
  res.json({ predecessor: chord.predecessor });
});

app.post('/notify', (req, res) => {
  const accepted = chord.notify(req.body.node);
  res.json({ accepted, predecessor: chord.predecessor });
});

app.post('/insert', async (req, res) => {
  try {
    const record = normalizeRecord(req.body);
    const owner = await chord.findSuccessor(hashId(record.recordKey));
    if (owner.node.peerId !== peerId) {
      metrics.message();
      log(`Routing insert ${record.recordKey} to ${owner.node.peerId}`);
      const response = await fetchJson(`${owner.node.url}/insert`, {
        method: 'POST',
        body: JSON.stringify(record)
      });
      return res.json({
        ...response,
        routedBy: peerId,
        routingPath: owner.routingPath
      });
    }

    const inserted = storage.storeRecord(record, false);
    if (inserted) await replication.replicateRecord(record);
    await storeTemperatureIndex(record);
    await pht.insert(record);
    log(`Inserted ${record.recordKey} temp=${record.temperature}`);
    res.json({ ok: true, owner: peerId, recordKey: record.recordKey, inserted, routingPath: owner.routingPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/store', async (req, res) => {
  try {
    const record = normalizeRecord(req.body.record || req.body);
    storage.storeRecord(record, false);
    if (req.body.replicate !== false) await replication.replicateRecord(record);
    res.json({ ok: true, storedAt: peerId, recordKey: record.recordKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/store-replica', (req, res) => {
  const { kind } = req.body;
  if (kind === 'data') {
    storage.storeRecord(req.body.record, true);
    log(`Stored data replica ${req.body.record.recordKey}`);
    return res.json({ ok: true, replicaAt: peerId });
  }
  if (kind === 'pht') {
    storage.storePhtNode(req.body.node, true);
    log(`Stored PHT replica "${req.body.node.prefix || 'root'}"`);
    return res.json({ ok: true, replicaAt: peerId });
  }
  if (kind === 'temp-index') {
    storage.storeTemperatureRecord(req.body.record, true);
    log(`Stored temperature index replica ${req.body.record.recordKey}`);
    return res.json({ ok: true, replicaAt: peerId });
  }
  res.status(400).json({ error: 'kind must be data, pht, or temp-index' });
});

app.get('/local/scan', (req, res) => {
  const min = Number(req.query.min);
  const max = Number(req.query.max);
  res.json({ peerId, results: storage.scanRange(min, max, false) });
});

app.get('/query/dht', async (req, res) => {
  try {
    const min = Number(req.query.min);
    const max = Number(req.query.max);
    res.json(await query.naiveDhtRangeScan(min, max));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/query/pht', async (req, res) => {
  try {
    const min = Number(req.query.min);
    const max = Number(req.query.max);
    res.json(await query.phtRangeQuery(min, max));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/query/points', async (req, res) => {
  try {
    const min = Number(req.query.min);
    const max = Number(req.query.max);
    res.json(await query.individualPointLookups(min, max));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/query/compare', async (req, res) => {
  try {
    const min = Number(req.query.min);
    const max = Number(req.query.max);
    res.json(await query.compare(min, max));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/pht', (_req, res) => {
  res.json({ peerId, pht: storage.allPhtNodes() });
});

app.post('/pht/store', async (req, res) => {
  try {
    const node = req.body.node;
    if (!node || typeof node.prefix !== 'string') {
      return res.status(400).json({ error: 'node.prefix is required' });
    }
    const owner = await chord.findSuccessor(prefixHash(node.prefix));
    node.ownerPeer = owner.node.peerId;
    if (owner.node.peerId !== peerId) {
      metrics.message();
      const response = await fetchJson(`${owner.node.url}/pht/store`, {
        method: 'POST',
        body: JSON.stringify(req.body)
      });
      return res.json(response);
    }
    storage.storePhtNode(node, false);
    if (req.body.replicate !== false) await replication.replicatePhtNode(node);
    res.json({ ok: true, storedAt: peerId, prefix: node.prefix, ownerPeer: node.ownerPeer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/pht/lookup', (req, res) => {
  const prefix = String(req.query.prefix ?? '');
  const includeReplica = req.query.replica === 'true' || req.query.replica === true;
  const node = storage.getPhtNode(prefix, includeReplica);
  if (!node) return res.status(404).json({ error: 'PHT node not found', prefix, node: null });

  const min = req.query.min !== undefined ? Number(req.query.min) : null;
  const max = req.query.max !== undefined ? Number(req.query.max) : null;
  const results = min === null || max === null || !node.isLeaf
    ? []
    : node.records.filter((record) => record.temperature >= min && record.temperature <= max);

  res.json({ peerId, prefix, node, results });
});

app.post('/temperature-index/store', async (req, res) => {
  try {
    const record = normalizeRecord(req.body.record || req.body);
    const owner = await chord.findSuccessor(hashId(`temp:${record.temperature}`));
    if (owner.node.peerId !== peerId) {
      metrics.message();
      const response = await fetchJson(`${owner.node.url}/temperature-index/store`, {
        method: 'POST',
        body: JSON.stringify({ record, replicate: req.body.replicate })
      });
      return res.json(response);
    }
    storage.storeTemperatureRecord(record, false);
    if (req.body.replicate !== false) await replication.replicateTemperatureRecord(record);
    res.json({ ok: true, storedAt: peerId, temperature: record.temperature, recordKey: record.recordKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/temperature-index/lookup', (req, res) => {
  const temperature = Number(req.query.temperature);
  if (!Number.isInteger(temperature) || temperature < -20 || temperature > 50) {
    return res.status(400).json({ error: 'temperature must be an integer from -20 to 50' });
  }
  const includeReplica = req.query.replica === 'true' || req.query.replica === true;
  res.json({
    peerId,
    temperature,
    results: storage.getTemperatureRecords(temperature, includeReplica)
  });
});

app.get('/metrics', (_req, res) => {
  res.json(metrics.snapshot({
    peer: chord.info(),
    storage: storage.stats(),
    ringVisualization: {
      self: chord.self,
      successor: chord.successor,
      predecessor: chord.predecessor,
      fingers: chord.fingerTable
    }
  }));
});

function normalizeRecord(input) {
  const id = Number(input.id);
  const temperature = Number(input.temperature);
  if (!Number.isInteger(id)) throw new Error('record.id must be an integer');
  if (!Number.isInteger(temperature) || temperature < -20 || temperature > 50) {
    throw new Error('temperature must be an integer from -20 to 50');
  }
  return {
    id,
    sensorId: input.sensorId || `S${String(id).padStart(3, '0')}`,
    temperature,
    timestamp: input.timestamp || new Date().toISOString(),
    recordKey: input.recordKey || `${temperature}_${id}`
  };
}

async function storeTemperatureIndex(record) {
  const owner = await chord.findSuccessor(hashId(`temp:${record.temperature}`));
  if (owner.node.peerId === peerId) {
    storage.storeTemperatureRecord(record, false);
    await replication.replicateTemperatureRecord(record);
    return;
  }

  metrics.message();
  await fetchJson(`${owner.node.url}/temperature-index/store`, {
    method: 'POST',
    body: JSON.stringify({ record })
  });
}

async function joinOnce() {
  if (joined) return;
  await chord.join();
  const byId = new Map([...(chord.knownPeers || []), ...peerList].map((peer) => [peer.peerId, peer]));
  chord.knownPeers = [...byId.values()];
  joined = true;
  chord.startMaintenance();
  setTimeout(() => pht.ensureRoot().catch((error) => log(`WARN ensure root failed: ${error.message}`)), 2000);
}

app.listen(PORT, async () => {
  log(`listening on ${PORT} hash=${chord.self.hashId}`);
  setTimeout(() => joinOnce().catch((error) => log(`WARN join failed: ${error.message}`)), Number(process.env.JOIN_DELAY_MS || 1000));
});
