import crypto from 'crypto';
import express from 'express';

const M = 8;
const RING_SIZE = 2 ** M;
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());

const peers = new Map();

function hashId(key) {
  return parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').substring(0, 2), 16) % RING_SIZE;
}

function sortedPeers() {
  return [...peers.values()].sort((a, b) => a.hashId - b.hashId);
}

function findSuccessor(id) {
  const ring = sortedPeers();
  if (!ring.length) return null;
  return ring.find((peer) => peer.hashId >= id) || ring[0];
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', role: 'bootstrap-node', peers: peers.size });
});

app.post('/register', (req, res) => {
  const { peerId, hashId: providedHashId, url } = req.body;
  if (!peerId || !url) {
    return res.status(400).json({ error: 'peerId and url are required' });
  }
  const node = { peerId, hashId: Number(providedHashId ?? hashId(peerId)), url };
  peers.set(peerId, node);
  console.log(`[Bootstrap] Registered ${peerId} hash=${node.hashId} url=${url}`);
  res.json({ ok: true, node, peers: sortedPeers() });
});

app.get('/peers', (_req, res) => {
  res.json({ peers: sortedPeers() });
});

app.get('/find-successor', (req, res) => {
  const id = Number(req.query.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'id is required' });
  }
  const successor = findSuccessor(id);
  res.json({
    id,
    successor,
    routingPath: ['bootstrap-node'],
    note: 'Introducer only. Peers perform query routing after join.'
  });
});

app.listen(PORT, () => {
  console.log(`[Bootstrap] listening on ${PORT}`);
});
