// Web Push sender — pure Web Crypto, no npm dependencies.
//
// Implements VAPID (RFC 8292) auth + aes128gcm payload encryption (RFC 8291)
// so it can run unchanged in Deno Edge Functions. Callers only need to hand it
// a stored subscription and a JSON payload; the module handles the elliptic
// curve maths, HKDF, and POST.
//
// VAPID keys are read from environment: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// (both base64url), VAPID_SUBJECT (mailto: or https: URL, contact for push
// service abuse reports).

// deno-lint-ignore-file no-explicit-any

export interface PushSubscription {
  id?: string;
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed EC point
  auth: string;   // base64url, 16 bytes
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** True when the push service reports the subscription is gone (404/410).
   *  Caller should delete the subscription row. */
  gone?: boolean;
}

// ---- base64url helpers ----------------------------------------------------

export function b64uToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- JWT (ES256) for VAPID ------------------------------------------------

async function importVapidPrivateKey(privB64u: string): Promise<CryptoKey> {
  // VAPID private key is the raw 32-byte scalar 'd'. Web Crypto's importKey
  // needs a JWK containing d + x + y — so we derive x/y from the public key.
  const pubB64u = Deno.env.get('VAPID_PUBLIC_KEY');
  if (!pubB64u) throw new Error('VAPID_PUBLIC_KEY not set');
  const pub = b64uToBytes(pubB64u);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed EC point');
  }
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = b64uToBytes(privB64u);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256', ext: false,
      d: bytesToB64u(d), x: bytesToB64u(x), y: bytesToB64u(y),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function makeVapidHeaders(endpoint: string): Promise<Record<string, string>> {
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const sub = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:kimmy@liquidandlarder.com.au';
  if (!pub || !priv) throw new Error('VAPID keys not configured');

  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud, exp: now + 12 * 60 * 60, sub };

  const enc = new TextEncoder();
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;

  const key = await importVapidPrivateKey(priv);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  ));
  const jwt = `${signingInput}.${bytesToB64u(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${pub}` };
}

// ---- aes128gcm payload encryption (RFC 8291) ------------------------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

async function encryptAes128Gcm(
  payload: Uint8Array,
  clientP256dh: Uint8Array,
  clientAuth: Uint8Array,
): Promise<Uint8Array> {
  // Ephemeral P-256 key pair for this send.
  const ecdh = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const localPubJwk = await crypto.subtle.exportKey('jwk', ecdh.publicKey);
  const localPub = concatBytes(
    new Uint8Array([0x04]),
    b64uToBytes(localPubJwk.x!),
    b64uToBytes(localPubJwk.y!),
  );

  // Import the client's raw public key (uncompressed EC point) for ECDH.
  if (clientP256dh.length !== 65 || clientP256dh[0] !== 0x04) {
    throw new Error('Subscription p256dh key is malformed');
  }
  const clientPubKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256', ext: true,
      x: bytesToB64u(clientP256dh.slice(1, 33)),
      y: bytesToB64u(clientP256dh.slice(33, 65)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey },
    ecdh.privateKey,
    256,
  );
  const shared = new Uint8Array(sharedBits);

  // Random 16-byte salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291: PRK_key = HKDF(auth, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const enc = new TextEncoder();
  const keyInfo = concatBytes(
    enc.encode('WebPush: info\0'),
    clientP256dh,
    localPub,
  );
  const ikm = await hkdf(clientAuth, shared, keyInfo, 32);

  // Then HKDF again with the random salt to derive CEK and nonce.
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Pad: payload || 0x02 || 0x00 * (padLen). We use zero extra padding.
  const padded = concatBytes(payload, new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    padded,
  ));

  // aes128gcm framing: salt(16) || rs(4, big-endian) || idlen(1) || keyid(idlen) || ciphertext.
  // Per RFC 8291, keyid for Web Push carries the sender's ephemeral pubkey (65 bytes),
  // and rs = 4096 is fine for our tiny payloads.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const idlen = new Uint8Array([localPub.length]); // 65
  return concatBytes(salt, rs, idlen, localPub, ct);
}

// ---- send -----------------------------------------------------------------

export async function sendPush(
  sub: PushSubscription,
  payload: unknown,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<SendResult> {
  try {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    if (body.length > 3993) {
      // aes128gcm has a small header overhead; 4KB is the safe max most services accept.
      return { ok: false, error: 'Payload too large for Web Push (>4KB after encryption)' };
    }
    const cipher = await encryptAes128Gcm(
      body,
      b64uToBytes(sub.p256dh),
      b64uToBytes(sub.auth),
    );
    const vapid = await makeVapidHeaders(sub.endpoint);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        ...vapid,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(opts.ttl ?? 60 * 60 * 24), // 24h default
        'Urgency': opts.urgency ?? 'normal',
      },
      body: cipher,
    });
    if (res.ok) return { ok: true, status: res.status };
    // 404 (gone) and 410 (subscription expired/unsubscribed) → drop the sub.
    const gone = res.status === 404 || res.status === 410;
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, gone, error: text.slice(0, 300) || res.statusText };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Convenience: send the same payload to every subscription; delete the ones
 *  the push service says are gone. Returns per-endpoint results. */
export async function sendToSubs(
  admin: any,
  subs: PushSubscription[],
  payload: unknown,
): Promise<{ sent: number; failed: number; gone: number; results: Array<{ id?: string; endpoint: string; result: SendResult }> }> {
  const results = await Promise.all(subs.map(async (s) => ({ id: s.id, endpoint: s.endpoint, result: await sendPush(s, payload) })));
  let sent = 0, failed = 0, gone = 0;
  const idsToDelete: string[] = [];
  for (const r of results) {
    if (r.result.ok) sent++;
    else {
      failed++;
      if (r.result.gone && r.id) { gone++; idsToDelete.push(r.id); }
      else if (r.id) {
        try {
          await admin.from('push_subscriptions')
            .update({ last_error: r.result.error?.slice(0, 500) ?? String(r.result.status) })
            .eq('id', r.id);
        } catch (_) { /* best-effort */ }
      }
    }
  }
  if (idsToDelete.length) {
    try {
      await admin.from('push_subscriptions').delete().in('id', idsToDelete);
    } catch (_) { /* best-effort */ }
  }
  return { sent, failed, gone, results };
}
