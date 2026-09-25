'use strict';

// AES-256-GCM encryption for backups and stored two-factor secrets.
// Layout: "ABA1" | 12-byte IV | 16-byte auth tag | ciphertext.
const crypto = require('node:crypto');

const MAGIC = Buffer.from('ABA1');

function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function decrypt(key, box) {
  if (box.length < 32 || !box.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted ABA file.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(4, 16));
  decipher.setAuthTag(box.subarray(16, 32));
  try {
    return Buffer.concat([decipher.update(box.subarray(32)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt: wrong encryption key, or the file is damaged.');
  }
}

const encryptText = (key, text) => encrypt(key, Buffer.from(text, 'utf8')).toString('base64');
const decryptText = (key, b64) => decrypt(key, Buffer.from(b64, 'base64')).toString('utf8');

module.exports = { encrypt, decrypt, encryptText, decryptText };
