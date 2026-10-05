import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getConfig } from '../config';

// Server-only: never import from src/lib or client components.

// Blob layout: 1-byte version | 12-byte IV | 16-byte GCM auth tag | ciphertext.
const VERSION = 0x01;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

function getKey(): Buffer {
  return Buffer.from(getConfig().TOKEN_ENCRYPTION_KEY, 'base64');
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function decryptSecret(blob: Buffer): string {
  // Messages never include plaintext, ciphertext or key material.
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LENGTH) {
    throw new SecretDecryptionError('Secret blob is malformed');
  }
  if (blob[0] !== VERSION) {
    throw new SecretDecryptionError('Unsupported secret blob version');
  }
  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const tag = blob.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH);
  const key = getKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError('Secret decryption failed');
  }
}
