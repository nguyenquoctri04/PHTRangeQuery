import fs from 'fs';

const output = new URL('../dataset.json', import.meta.url);
const records = [];
const TOTAL_RECORDS = Number(process.env.DATASET_SIZE || 1000);

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let seed = 67;
function random() {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
}

function weightedTemperature() {
  if (random() < 0.72) return randomInt(20, 40);
  return randomInt(-20, 50);
}

for (let id = 1; id <= TOTAL_RECORDS; id += 1) {
  const temperature = weightedTemperature();
  records.push({
    id,
    sensorId: `S${String(randomInt(1, 120)).padStart(3, '0')}`,
    temperature,
    timestamp: new Date(Date.UTC(2026, 4, 27, 10, 0, id)).toISOString()
  });
}

fs.writeFileSync(output, JSON.stringify(records, null, 2));

const distribution = records.reduce((acc, record) => {
  const bucket = record.temperature < 0
    ? '[-20,-1]'
    : record.temperature <= 19
      ? '[0,19]'
      : record.temperature <= 40
        ? '[20,40]'
        : '[41,50]';
  acc[bucket] = (acc[bucket] || 0) + 1;
  return acc;
}, {});

console.log(`Generated ${records.length} records at dataset.json (DATASET_SIZE=${TOTAL_RECORDS})`);
console.log(distribution);
