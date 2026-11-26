/**
 * warp's local certificate authority.
 *
 * On first use it generates a self-signed P-256 root, persists it under
 * ~/.inkling, and mints leaf certs per SNI host on demand so the CONNECT proxy
 * can terminate (and therefore route) the agent's TLS. Only the child process
 * trusts it: warp points the child's NODE_EXTRA_CA_CERTS at the root, so
 * nothing is installed in the system keychain and no other process on the
 * machine is affected.
 *
 * Ported from wardex ca.go. The certificate assembly is hand-rolled because
 * Node has no equivalent of Go's x509.CreateCertificate — see ./der.ts.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import * as tls from 'node:tls';
import { createSecureContext, type SecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bitString,
  bool,
  contextTag,
  integer,
  octetString,
  oid,
  pem,
  seq,
  set,
  utcTime,
  utf8String,
} from './der.js';

const textEncoder = new TextEncoder();

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** DER encoding of OID 2.5.29.14 (subjectKeyIdentifier) used to detect legacy CAs missing SKI. */
const SKI_OID_DER = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0e]);
const MAX_LEAF_CONTEXTS = 256;

const CA_COMMON_NAME = 'inkling warp local CA';
const CA_ORGANIZATION = 'inkling';

/** ecdsa-with-SHA256 takes no parameters, so the AlgorithmIdentifier is bare. */
const SIG_ALGORITHM = seq(oid(OID_ECDSA_SHA256));

function distinguishedName(commonName: string, organization?: string): Uint8Array {
  const rdns = [set(seq(oid(OID_COMMON_NAME), utf8String(commonName)))];
  if (organization) rdns.push(set(seq(oid(OID_ORGANIZATION), utf8String(organization))));
  return seq(...rdns);
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  const parts = [oid(id)];
  if (critical) parts.push(bool(true));
  parts.push(octetString(value));
  return seq(...parts);
}

/**
 * KeyUsage is a BIT STRING indexed from the most significant bit:
 * digitalSignature(0), keyCertSign(5), cRLSign(6). The trailing count of unused
 * bits has to match the last bit we actually set or strict verifiers complain.
 */
function keyUsageExtension(bits: number[]): Uint8Array {
  const highest = Math.max(...bits);
  const byteCount = Math.floor(highest / 8) + 1;
  const bytes = new Uint8Array(byteCount);
  for (const bit of bits) bytes[Math.floor(bit / 8)]! |= 0x80 >> bit % 8;
  const unused = byteCount * 8 - (highest + 1);
  return extension(OID_KEY_USAGE, true, bitString(bytes, unused));
}

/** GeneralName: dNSName is [2] IMPLICIT IA5String, iPAddress is [7] OCTET STRING. */
function subjectAltNameExtension(host: string, critical = false): Uint8Array {
  if (isIP(host)) {
    const octets =
      isIP(host) === 4
        ? Uint8Array.from(host.split('.').map((o) => Number.parseInt(o, 10)))
        : ipv6Bytes(host);
    return extension(OID_SUBJECT_ALT_NAME, critical, seq(contextTag(7, octets, false)));
  }
  // [2] IMPLICIT IA5String requires 7-bit ASCII characters.
  if (/[^\x20-\x7e]/.test(host)) {
    throw new Error(`Invalid non-ASCII DNS SAN host: ${host}`);
  }
  // Re-encode content rather than slicing header off ia5String() so >127-char hosts encode cleanly.
  return extension(
    OID_SUBJECT_ALT_NAME,
    critical,
    seq(contextTag(2, textEncoder.encode(host), false)),
  );
}

function readDerTlv(
  buf: Uint8Array,
  offset: number,
): { tag: number; contentStart: number; contentEnd: number; next: number } {
  const tag = buf[offset]!;
  const lenByte = buf[offset + 1]!;
  let len = 0;
  let contentStart = offset + 2;
  if (lenByte < 0x80) {
    len = lenByte;
  } else {
    const count = lenByte & 0x7f;
    for (let i = 0; i < count; i++) {
      len = len * 256 + buf[offset + 2 + i]!;
    }
    contentStart = offset + 2 + count;
  }
  const contentEnd = contentStart + len;
  return { tag, contentStart, contentEnd, next: contentEnd };
}

/** RFC 5280 §4.2.1.2 Method 1: 160-bit SHA-1 of the BIT STRING subjectPublicKey value (without unused-bits byte). */
function subjectKeyIdentifier(pubKey: KeyObject): Uint8Array {
  const spki = new Uint8Array(pubKey.export({ type: 'spki', format: 'der' }));
  const outer = readDerTlv(spki, 0);
  const alg = readDerTlv(spki, outer.contentStart);
  const bitStr = readDerTlv(spki, alg.next);
  const rawKey = spki.subarray(bitStr.contentStart + 1, bitStr.contentEnd);
  return new Uint8Array(createHash('sha1').update(rawKey).digest());
}

function spkiSha256Base64(pubKey: KeyObject): string {
  const spki = pubKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

function writeFileAtomic(filePath: string, content: string, mode: number): void {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, filePath);
    chmodSync(filePath, mode);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }
}

function ipv6Bytes(host: string): Uint8Array {
  const cleanHost = host.split('%')[0] ?? host;
  const lastColon = cleanHost.lastIndexOf(':');
  let normalized = cleanHost;
  if (lastColon >= 0 && cleanHost.slice(lastColon + 1).includes('.')) {
    const octets = cleanHost.slice(lastColon + 1).split('.').map((o) => Number.parseInt(o, 10));
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
      const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
      normalized = `${cleanHost.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
  }
  const [head, tail] = normalized.split('::');
  const parse = (part: string) => (part ? part.split(':').filter(Boolean) : []);
  const left = parse(head ?? '');
  const right = parse(tail ?? '');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    if (i >= 8) return;
    const v = Number.parseInt(group, 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

interface CertificateSpec {
  subject: Uint8Array;
  issuer: Uint8Array;
  subjectPublicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Uint8Array[];
}

/**
 * Assemble and self-sign a TBSCertificate. The SubjectPublicKeyInfo comes
 * straight out of node:crypto's SPKI export, so we never hand-encode a curve
 * point; everything else is RFC 5280 boilerplate.
 */
function buildCertificate(spec: CertificateSpec): Uint8Array {
  const spki = new Uint8Array(spec.subjectPublicKey.export({ type: 'spki', format: 'der' }));
  const tbs = seq(
    contextTag(0, integer(2)), // v3
    integer(new Uint8Array(randomBytes(16))),
    SIG_ALGORITHM,
    spec.issuer,
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    spec.subject,
    spki,
    contextTag(3, seq(...spec.extensions)),
  );
  const signature = new Uint8Array(sign('sha256', tbs, spec.signingKey));
  return seq(tbs, SIG_ALGORITHM, bitString(signature));
}

function newKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function privateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Where the OS keeps its public root bundle. `SSL_CERT_FILE`,
 * `CURL_CA_BUNDLE` and `REQUESTS_CA_BUNDLE` REPLACE the trust store rather
 * than extend it, so a file holding only our CA would make every non-inkling
 * HTTPS call in the child fail verification (gcloud, gws, pip: #245). The
 * first path that exists wins; none found falls back to {@link osStoreRoots}.
 */
const SYSTEM_ROOT_BUNDLES = [
  '/etc/ssl/cert.pem', // macOS, Alpine, FreeBSD
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Arch
  '/etc/pki/tls/certs/ca-bundle.crt', // RHEL, Fedora, CentOS
  '/etc/ssl/ca-bundle.pem', // openSUSE
];

export function findSystemRootBundle(candidates: readonly string[] = SYSTEM_ROOT_BUNDLES): string | null {
  const fromEnv = process.env.SSL_CERT_FILE;
  // An operator-supplied bundle is the trust store the child would have had
  // without us; prefer it over the platform guess. Skip it if it is already
  // one of our own files, or the bundle would nest on every warp restart.
  if (fromEnv && existsSync(fromEnv) && !/warp-ca(-bundle)?\.pem$/.test(fromEnv)) return fromEnv;
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export const OS_STORE = 'the OS certificate store';

/**
 * Windows keeps its roots in the certificate store, not in a file, so none of
 * the paths above exist there. Node 22.15+/23.10+ can export that store as PEM;
 * on older runtimes this returns '' and the bundle stays CA-only as before.
 */
export function osStoreRoots(): string {
  const get = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  try {
    return get ? get('system').join('\n') : '';
  } catch {
    return '';
  }
}

/** The public roots to append to our CA, and where they came from (null: none). */
export function readSystemRoots(
  candidates: readonly string[] = SYSTEM_ROOT_BUNDLES,
  osStore: () => string = osStoreRoots,
): { pem: string; source: string | null } {
  const path = findSystemRootBundle(candidates);
  if (path) {
    try {
      const pem = readFileSync(path, 'utf8');
      if (pem) return { pem, source: path };
    } catch {
      /* unreadable: try the OS store */
    }
  }
  const pem = osStore();
  return pem ? { pem, source: OS_STORE } : { pem: '', source: null };
}

export class CertificateAuthority {
  private readonly leaves = new Map<string, SecureContext>();
  private readonly leafSki: Uint8Array;
  readonly spkiPins: readonly string[];

  private constructor(
    private readonly certPem: string,
    private readonly caKey: KeyObject,
    private readonly caSki: Uint8Array,
    private readonly leafKey: KeyObject,
    private readonly leafKeyPem: string,
    readonly certPath: string,
    /** Our CA followed by the system roots; see {@link writeBundle}. */
    readonly bundlePath: string,
    /** Where the roots came from (a file path or {@link OS_STORE}); null when `bundlePath` is CA-only. */
    readonly systemRootsPath: string | null,
    readonly spkiPin: string,
  ) {
    this.leafSki = subjectKeyIdentifier(leafKey);
    this.spkiPins = [spkiSha256Base64(leafKey), spkiPin];
  }

  /**
   * Write `warp-ca-bundle.pem` = our CA + the system roots, for the env vars
   * that replace the trust store. Regenerated on every load: the system bundle
   * rotates underneath us and the cost is one file write.
   */
  private static writeBundle(dir: string, certPem: string): { bundlePath: string; systemRootsPath: string | null } {
    const bundlePath = join(dir, 'warp-ca-bundle.pem');
    const { pem: roots, source } = readSystemRoots();
    const sep = roots && !roots.endsWith('\n') ? '\n' : '';
    writeFileAtomic(bundlePath, certPem + roots + sep, 0o600);
    return { bundlePath, systemRootsPath: source };
  }

  /**
   * Load the persisted CA, or create and persist one. A CA that fails to load,
   * lacks modern strict-X509 extensions (SKI), mismatches its key, or has expired
   * is replaced rather than reported: it is entirely derived state.
   */
  static loadOrCreate(dir: string): CertificateAuthority {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    const certPath = join(dir, 'warp-ca.pem');
    const keyPath = join(dir, 'warp-ca-key.pem');

    try {
      const certPem = readFileSync(certPath, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      const parsed = new X509Certificate(certPem);
      const caKey = createPrivateKey(keyPem);
      const caPubFromKey = createPublicKey(caKey).export({ type: 'spki', format: 'der' });
      const caPubFromCert = parsed.publicKey.export({ type: 'spki', format: 'der' });
      const hasSki = parsed.raw.includes(SKI_OID_DER);
      const now = Date.now();
      const validFrom = new Date(parsed.validFrom).getTime();
      const validTo = new Date(parsed.validTo).getTime();
      if (
        parsed.ca === true &&
        validFrom <= now &&
        validTo > now + 365 * 24 * 60 * 60 * 1000 &&
        hasSki &&
        Buffer.from(caPubFromKey).equals(Buffer.from(caPubFromCert))
      ) {
        try {
          chmodSync(keyPath, 0o600);
          chmodSync(certPath, 0o600);
        } catch {
          /* ignore */
        }
        const caSki = subjectKeyIdentifier(parsed.publicKey);
        const spkiPin = spkiSha256Base64(parsed.publicKey);
        const leaf = newKeyPair();
        const bundle = CertificateAuthority.writeBundle(dir, certPem);
        return new CertificateAuthority(
          certPem,
          caKey,
          caSki,
          leaf.publicKey,
          privateKeyPem(leaf.privateKey),
          certPath,
          bundle.bundlePath,
          bundle.systemRootsPath,
          spkiPin,
        );
      }
    } catch {
      // fall through and mint a fresh CA
    }

    const ca = newKeyPair();
    const name = distinguishedName(CA_COMMON_NAME, CA_ORGANIZATION);
    const caSki = subjectKeyIdentifier(ca.publicKey);
    const spkiPin = spkiSha256Base64(ca.publicKey);
    const now = Date.now();
    const der = buildCertificate({
      subject: name,
      issuer: name,
      subjectPublicKey: ca.publicKey,
      signingKey: ca.privateKey,
      notBefore: new Date(now - 60 * 60 * 1000),
      notAfter: new Date(now + 10 * 365 * 24 * 60 * 60 * 1000),
      extensions: [
        // pathLen 0: this root may sign leaves, never intermediates.
        extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true), integer(0))),
        keyUsageExtension([0, 5, 6]),
        extension(OID_SUBJECT_KEY_IDENTIFIER, false, octetString(caSki)),
        extension(OID_AUTHORITY_KEY_IDENTIFIER, false, seq(contextTag(0, caSki, false))),
      ],
    });

    const certPem = pem('CERTIFICATE', der);
    // Write private key first so readers never observe a new cert paired with a stale key.
    writeFileAtomic(keyPath, privateKeyPem(ca.privateKey), 0o600);
    writeFileAtomic(certPath, certPem, 0o600);

    const leaf = newKeyPair();
    const bundle = CertificateAuthority.writeBundle(dir, certPem);
    return new CertificateAuthority(
      certPem,
      ca.privateKey,
      caSki,
      leaf.publicKey,
      privateKeyPem(leaf.privateKey),
      certPath,
      bundle.bundlePath,
      bundle.systemRootsPath,
      spkiPin,
    );
  }

  /** Mint a leaf X.509 PEM certificate signed by this CA for `host`. */
  mintLeafCertPem(host: string): string {
    const stripped = host.replace(/\.$/, '');
    const name = isIP(stripped) ? stripped : stripped.toLowerCase();
    const now = Date.now();
    // RFC 5280 caps CommonName at 64 chars; for long hosts use an empty Subject DN + critical SAN.
    const subject = name.length > 64 ? seq() : distinguishedName(name);
    const sanCritical = name.length > 64;
    const der = buildCertificate({
      subject,
      issuer: distinguishedName(CA_COMMON_NAME, CA_ORGANIZATION),
      subjectPublicKey: this.leafKey,
      signingKey: this.caKey,
      notBefore: new Date(now - 60 * 60 * 1000),
      notAfter: new Date(now + 365 * 24 * 60 * 60 * 1000),
      extensions: [
        extension(OID_BASIC_CONSTRAINTS, true, seq()),
        keyUsageExtension([0]),
        extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
        subjectAltNameExtension(name, sanCritical),
        extension(OID_SUBJECT_KEY_IDENTIFIER, false, octetString(this.leafSki)),
        extension(OID_AUTHORITY_KEY_IDENTIFIER, false, seq(contextTag(0, this.caSki, false))),
      ],
    });
    return pem('CERTIFICATE', der);
  }

  /**
   * Mint PEM `{ key, cert }` credentials for `host` (root included for full chain validation).
   * Useful both for SNI contexts and TLS servers bound to IP literals where clients omit SNI.
   */
  leafCredentialsFor(host: string): { key: string; cert: string } {
    const stripped = host.replace(/\.$/, '');
    const name = isIP(stripped) ? stripped : stripped.toLowerCase();
    return {
      key: this.leafKeyPem,
      // Ship the root alongside the leaf so the child validates the whole chain
      // from NODE_EXTRA_CA_CERTS without a separate fetch.
      cert: this.mintLeafCertPem(name) + this.certPem,
    };
  }

  /**
   * Cached-or-minted TLS context for an SNI host. One leaf key is reused across
   * every host: these certs never leave the machine and are only trusted by the
   * child we spawned, so per-host keygen would buy nothing but latency on the
   * first request to each host.
   */
  secureContextFor(host: string): SecureContext {
    const stripped = host.replace(/\.$/, '');
    const name = isIP(stripped) ? stripped : stripped.toLowerCase();
    const cached = this.leaves.get(name);
    if (cached) {
      this.leaves.delete(name);
      this.leaves.set(name, cached);
      return cached;
    }

    const context = createSecureContext(this.leafCredentialsFor(name));
    if (this.leaves.size >= MAX_LEAF_CONTEXTS) {
      const oldest = this.leaves.keys().next().value;
      if (oldest !== undefined) this.leaves.delete(oldest);
    }
    this.leaves.set(name, context);
    return context;
  }
}
