import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

export interface TlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 of the certificate, the value people compare when pairing a client. */
  fingerprint: string;
}

/**
 * The host's identity on the LAN. It is generated once and kept, because clients pin this
 * exact certificate: regenerating it would make every paired client refuse to connect.
 */
export async function loadOrCreateTls(dataDir: string): Promise<TlsMaterial> {
  const dir = join(dataDir, 'tls');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8');
    const parsed = new X509Certificate(cert);
    // Renew well before expiry; clients are told to re-pair by the fingerprint change.
    if (new Date(parsed.validTo).getTime() > Date.now() + 7 * 24 * 60 * 60 * 1000) {
      return { cert, key: readFileSync(keyPath, 'utf8'), fingerprint: parsed.fingerprint256 };
    }
  }

  mkdirSync(dir, { recursive: true });
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  const generated = await selfsigned.generate([{ name: 'commonName', value: `Job Tracker Host (${hostname()})` }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  });
  writeFileSync(keyPath, generated.private, { mode: 0o600 });
  writeFileSync(certPath, generated.cert);
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows permissions come from the per-user application data directory.
  }
  return {
    cert: generated.cert,
    key: generated.private,
    fingerprint: new X509Certificate(generated.cert).fingerprint256
  };
}
