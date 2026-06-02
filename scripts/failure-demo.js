const coordinator = process.env.COORDINATOR || 'http://localhost:3001';

async function json(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url}: ${payload.error || response.statusText}`);
  return payload;
}

const before = await json(`${coordinator}/query/pht?min=20&max=25`);

console.log('Before failure:', {
  resultsCount: before.resultsCount,
  peersContacted: before.peersContacted,
  messagesSent: before.messagesSent,
  latencyMs: before.latencyMs
});

console.log('\nNow run in another terminal:');
console.log('  docker stop peer3');
console.log('\nWait 10-15 seconds, then run:');
console.log('  curl "http://localhost:3001/query/pht?min=20&max=25"');
console.log('\nExpected: resultsCount should remain the same because PHT nodes are replicated to successor peers.');
