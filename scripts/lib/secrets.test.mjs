import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hex32, passphrase, ed25519, ed25519PublicFromPrivate, generate } from './secrets.mjs';

test('hex32 is 64 hex chars and random', () => {
  const a = hex32();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hex32());
});

test('passphrase is 4 words + 2 digits', () => {
  for (let i = 0; i < 20; i++) assert.match(passphrase(), /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
});

test('ed25519 key is in the format receipts.js parses, and the public key matches', () => {
  const k = ed25519();
  assert.match(k.privateRawHex, /^[0-9a-f]{64}$/);
  assert.match(k.publicRawHex, /^[0-9a-f]{64}$/);
  assert.match(k.publicKey, /^[A-Za-z0-9_-]{43}$/);
  // Same parsing as services/*/receipts.js createPrivateKey + reviewGrantPublicKey
  const priv = crypto.createPrivateKey({ key: Buffer.from(k.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.publicKey }, format: 'jwk' });
  const msg = Buffer.from('grant');
  assert.ok(crypto.verify(null, msg, pub, crypto.sign(null, msg, priv)));
  assert.equal(ed25519PublicFromPrivate(k.privateKey), k.publicKey);
  assert.equal(Buffer.from(k.publicKey, 'base64url').toString('hex'), k.publicRawHex);
  assert.equal(ed25519PublicFromPrivate('not-a-key'), null);
});

test('generate dispatches by kind', () => {
  assert.match(generate('hex32'), /^[0-9a-f]{64}$/);
  assert.ok(ed25519PublicFromPrivate(generate('ed25519')));
  assert.throws(() => generate('nope'));
});
