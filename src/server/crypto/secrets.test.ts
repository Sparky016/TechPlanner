import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, SecretDecryptionError } from './secrets';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

let currentKey = KEY_A;

vi.mock('../config', () => ({
  getConfig: () => ({ TOKEN_ENCRYPTION_KEY: currentKey }),
}));

const IV_START = 1;
const TAG_START = 13;
const CIPHERTEXT_START = 29;

function expectDecryptionError(blob: Buffer): SecretDecryptionError {
  try {
    decryptSecret(blob);
  } catch (err) {
    expect(err).toBeInstanceOf(SecretDecryptionError);
    return err as SecretDecryptionError;
  }
  throw new Error('expected decryptSecret to throw');
}

beforeEach(() => {
  currentKey = KEY_A;
});

describe('encryptSecret / decryptSecret', () => {
  it.each([
    ['ascii', 'atlassian-access-token.abc123'],
    ['unicode', 'pässwörd ✓ 秘密 🔐'],
    ['empty string', ''],
  ])('round-trips %s', (_label, plaintext) => {
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it('produces the documented blob layout', () => {
    const blob = encryptSecret('hello');
    expect(blob[0]).toBe(0x01);
    expect(blob.length).toBe(CIPHERTEXT_START + Buffer.byteLength('hello'));
    expect(blob.includes(Buffer.from('hello'))).toBe(false);
  });

  it('yields different blobs and IVs for the same plaintext', () => {
    const blobs = Array.from({ length: 50 }, () => encryptSecret('same-token'));
    const hex = new Set(blobs.map((b) => b.toString('hex')));
    const ivs = new Set(blobs.map((b) => b.subarray(IV_START, TAG_START).toString('hex')));
    expect(hex.size).toBe(blobs.length);
    expect(ivs.size).toBe(blobs.length);
  });

  it('throws SecretDecryptionError when any byte of IV, tag or ciphertext is flipped', () => {
    const plaintext = 'refresh-token-value';
    const blob = encryptSecret(plaintext);
    for (let i = IV_START; i < blob.length; i++) {
      const tampered = Buffer.from(blob);
      tampered[i] ^= 0xff;
      const err = expectDecryptionError(tampered);
      expect(err.message).not.toContain(plaintext);
    }
  });

  it('throws SecretDecryptionError on an unknown version', () => {
    const blob = encryptSecret('x');
    blob[0] = 0x02;
    expectDecryptionError(blob);
  });

  it('throws SecretDecryptionError on a truncated blob', () => {
    expectDecryptionError(encryptSecret('x').subarray(0, CIPHERTEXT_START - 1));
    expectDecryptionError(Buffer.alloc(0));
  });

  it('throws SecretDecryptionError when decrypting with a different key', () => {
    const plaintext = 'access-token-value';
    const blob = encryptSecret(plaintext);
    currentKey = KEY_B;
    const err = expectDecryptionError(blob);
    for (const forbidden of [plaintext, KEY_A, KEY_B, blob.toString('hex'), blob.toString('base64')]) {
      expect(err.message).not.toContain(forbidden);
    }
  });
});
