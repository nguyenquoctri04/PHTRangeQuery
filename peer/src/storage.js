import fs from 'fs';
import path from 'path';

const storageDir = process.env.STORAGE_DIR || '/app/storage';

function ensureDir() {
  fs.mkdirSync(storageDir, { recursive: true });
}

function filePath(name) {
  ensureDir();
  return path.join(storageDir, name);
}

function readJson(name, fallback) {
  const target = filePath(name);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, JSON.stringify(fallback, null, 2));
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
}

export class JsonStorage {
  constructor(peerId) {
    this.peerId = peerId;
    this.dataFile = 'data.json';
    this.phtFile = 'pht.json';
    this.data = readJson(this.dataFile, { primary: [], replica: [] });
    this.pht = readJson(this.phtFile, { primary: {}, replica: {} });
    this.data.tempIndex ||= { primary: {}, replica: {} };
    this.data.tempIndex.primary ||= {};
    this.data.tempIndex.replica ||= {};
  }

  save() {
    this.saveData();
    this.savePht();
  }

  saveData() {
    writeJson(this.dataFile, this.data);
  }

  savePht() {
    writeJson(this.phtFile, this.pht);
  }

  storeRecord(record, replica = false) {
    const target = replica ? this.data.replica : this.data.primary;
    if (!target.some((item) => item.recordKey === record.recordKey)) {
      target.push(record);
      this.saveData();
      return true;
    }
    return false;
  }

  scanRange(min, max, includeReplica = false) {
    const source = includeReplica ? [...this.data.primary, ...this.data.replica] : this.data.primary;
    return source.filter((record) => record.temperature >= min && record.temperature <= max);
  }

  storeTemperatureRecord(record, replica = false) {
    const bucket = replica ? this.data.tempIndex.replica : this.data.tempIndex.primary;
    const key = String(record.temperature);
    bucket[key] ||= [];
    if (!bucket[key].some((item) => item.recordKey === record.recordKey)) {
      bucket[key].push(record);
      this.saveData();
    }
  }

  getTemperatureRecords(temperature, includeReplica = false) {
    const key = String(temperature);
    const primary = this.data.tempIndex.primary[key] || [];
    const replica = includeReplica ? this.data.tempIndex.replica[key] || [] : [];
    return [...primary, ...replica];
  }

  storePhtNode(node, replica = false) {
    const target = replica ? this.pht.replica : this.pht.primary;
    target[node.prefix] = node;
    this.savePht();
  }

  getPhtNode(prefix, includeReplica = false) {
    return this.pht.primary[prefix] || (includeReplica ? this.pht.replica[prefix] : undefined);
  }

  allPhtNodes() {
    return {
      primary: Object.values(this.pht.primary),
      replica: Object.values(this.pht.replica)
    };
  }

  stats() {
    return {
      dataPrimary: this.data.primary.length,
      dataReplica: this.data.replica.length,
      tempIndexPrimary: Object.values(this.data.tempIndex.primary).reduce((sum, records) => sum + records.length, 0),
      tempIndexReplica: Object.values(this.data.tempIndex.replica).reduce((sum, records) => sum + records.length, 0),
      phtPrimary: Object.keys(this.pht.primary).length,
      phtReplica: Object.keys(this.pht.replica).length
    };
  }
}
