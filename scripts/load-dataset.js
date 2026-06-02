import fs from 'fs';

const datasetUrl = new URL('../dataset.json', import.meta.url);

if (!fs.existsSync(datasetUrl)) {
  console.log('dataset.json not found. Generating dataset first...');
  await import('./generate-dataset.js');
}

const dataset = JSON.parse(fs.readFileSync(datasetUrl, 'utf8'));

const coordinator =
  process.env.COORDINATOR || 'http://127.0.0.1:3001';

/*
|--------------------------------------------------------------------------
| Helper
|--------------------------------------------------------------------------
*/

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/*
|--------------------------------------------------------------------------
| Fetch JSON with retry + timeout
|--------------------------------------------------------------------------
*/

async function json(url, options = {}, retry = 3) {
  for (let attempt = 1; attempt <= retry; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(60000)
      });

      let payload = {};

      try {
        payload = await response.json();
      } catch {
        payload = {};
      }

      if (!response.ok) {
        throw new Error(
          payload.error || response.statusText
        );
      }

      return payload;
    } catch (err) {
      console.error(
        `[Attempt ${attempt}/${retry}] ${url}`
      );

      console.error(err.message);

      if (attempt >= retry) {
        throw new Error(
          `${url}: ${err.message}`
        );
      }

      await sleep(1000);
    }
  }
}

/*
|--------------------------------------------------------------------------
| Wait for peers
|--------------------------------------------------------------------------
*/

async function waitForPeers() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const info = await json(
        `${coordinator}/peer-info`
      );

      if (
        info.successor &&
        info.fingerTable?.length === 8
      ) {
        console.log('Peers are ready');
        return;
      }
    } catch (err) {
      console.log(
        `Waiting peers... (${attempt + 1}/60)`
      );
    }

    await sleep(1000);
  }

  throw new Error('Peers are not ready');
}

/*
|--------------------------------------------------------------------------
| Insert dataset
|--------------------------------------------------------------------------
*/

await waitForPeers();

let inserted = 0;
let failed = 0;
let cursor = 0;

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 1);
const PROGRESS_EVERY = Number(process.env.LOAD_PROGRESS_EVERY || 500);

/*
|--------------------------------------------------------------------------
| Insert with controlled concurrency
|--------------------------------------------------------------------------
*/

async function insertOne(record) {
  const recordKey = `${record.temperature}_${record.id}`;
  await json(`${coordinator}/insert`, {
    method: 'POST',
    body: JSON.stringify({
      ...record,
      recordKey
    })
  });
}

async function worker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= dataset.length) return;

    const record = dataset[index];
    try {
      await insertOne(record);
      inserted += 1;
      if (inserted % PROGRESS_EVERY === 0 || inserted === dataset.length) {
        console.log(`Inserted ${inserted}/${dataset.length}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`Insert failed for record ${record.id}: ${err.message}`);
    }
  }
}

const workers = Array.from(
  { length: Math.max(1, CONCURRENCY) },
  () => worker()
);
await Promise.all(workers);

/*
|--------------------------------------------------------------------------
| Done
|--------------------------------------------------------------------------
*/

console.log(
  `Dataset distribution complete: ${inserted}/${dataset.length} records, failed=${failed}, concurrency=${CONCURRENCY}`
);
