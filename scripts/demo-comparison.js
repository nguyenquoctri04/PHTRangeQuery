import fs from 'fs';

const coordinator = process.env.COORDINATOR || 'http://127.0.0.1:3001';
const output = new URL('../report-results.json', import.meta.url);

async function json(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url}: ${payload.error || response.statusText}`);
  return payload;
}

async function compare(label, min, max) {
  const result = await json(`${coordinator}/query/compare?min=${min}&max=${max}`);
  const summary = summarizeComparison(label, result);
  console.log(`\n${label} ${min}..${max}`);
  console.log('Individual point lookups:', summary.pointLookups);
  console.log('PHT:', summary.pht);
  console.log('Improvement:', summary.improvement);
  return summary;
}

const narrow = await compare('NARROW', 20, 25);
const wide = await compare('WIDE', -10, 40);

const report = {
  generatedAt: new Date().toISOString(),
  narrow,
  wide,
  conclusion: {
    pointLookups: 'A DHT without range support must resolve each exact temperature point in the requested interval.',
    pht: 'PHT contacts only owners of relevant prefix leaves and reduces messages for selective ranges.'
  }
};

fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log('\nSaved report-results.json');

function summarizeComparison(label, result) {
  return {
    label,
    range: { min: result.min, max: result.max },
    pointLookups: summarizeQuery(result.pointLookups),
    pht: summarizeQuery(result.pht),
    improvement: result.improvement
  };
}

function summarizeQuery(query) {
  return {
    queryType: query.queryType,
    resultsCount: query.resultsCount,
    peersContacted: query.peersContacted,
    messagesSent: query.messagesSent,
    queryHops: query.queryHops,
    latencyMs: query.latencyMs,
    routingPathLength: query.routingPath.length,
    pointLookups: query.pointLookups,
    coveringPrefixes: query.coveringPrefixes,
    theoreticalCoveringPrefixes: query.theoreticalCoveringPrefixes
  };
}
