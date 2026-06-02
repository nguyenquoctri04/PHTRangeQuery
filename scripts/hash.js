import crypto from 'crypto';

export function hashId(key) {
  return parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').substring(0, 2), 16) % 256;
}
