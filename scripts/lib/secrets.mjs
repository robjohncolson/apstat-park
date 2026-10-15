// Local secret generation. Nothing here touches the network.
import crypto from 'node:crypto';

const WORDS = [
  'acorn', 'amber', 'anchor', 'arrow', 'aspen', 'badger', 'basil', 'beacon', 'birch', 'bison',
  'canyon', 'cedar', 'cobalt', 'comet', 'coral', 'cotton', 'crane', 'delta', 'ember', 'falcon',
  'fern', 'fjord', 'garnet', 'glacier', 'harbor', 'hazel', 'heron', 'indigo', 'island', 'jasper',
  'juniper', 'kestrel', 'lagoon', 'lantern', 'lemon', 'lichen', 'lotus', 'maple', 'meadow', 'mesa',
  'nectar', 'nimbus', 'oasis', 'onyx', 'orchid', 'otter', 'pebble', 'pepper', 'pine', 'prairie',
  'quartz', 'quill', 'raven', 'reef', 'river', 'saffron', 'sage', 'sierra', 'spruce', 'summit',
  'thistle', 'tundra', 'velvet', 'walnut', 'willow', 'yarrow', 'zephyr', 'zinnia'
];

export const hex32 = () => crypto.randomBytes(32).toString('hex');

export function passphrase() {
  const words = Array.from({ length: 4 }, () => WORDS[crypto.randomInt(WORDS.length)]);
  return `${words.join('-')}-${String(crypto.randomInt(100)).padStart(2, '0')}`;
}

// Ed25519 issuer key in the format the services actually parse (services/*/receipts.js):
//   RECEIPT_ISSUER_PRIVATE_KEY = base64 of the PKCS8 DER private key
//   REVIEW_GRANT_PUBKEY / /health receipts.pubkey = base64url JWK `x` (raw 32-byte public key)
// rawHex fields are informational (the 32-byte seed and public key as hex).
export function ed25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    privateKey: der.toString('base64'),
    publicKey: publicKey.export({ format: 'jwk' }).x,
    privateRawHex: Buffer.from(jwk.d, 'base64url').toString('hex'),
    publicRawHex: Buffer.from(jwk.x, 'base64url').toString('hex')
  };
}

// Public key (base64url x) for an existing RECEIPT_ISSUER_PRIVATE_KEY, or null if unparseable.
export function ed25519PublicFromPrivate(privateKeyB64) {
  try {
    const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
    return crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  } catch {
    return null;
  }
}

export function generate(kind) {
  if (kind === 'hex32') return hex32();
  if (kind === 'passphrase') return passphrase();
  if (kind === 'ed25519') return ed25519().privateKey;
  throw new Error(`unknown generator: ${kind}`);
}
