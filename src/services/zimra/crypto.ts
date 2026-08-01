// =============================================================================
// ZIMRA FDMS Cryptography Service
// src/services/zimra/crypto.ts
// =============================================================================
// Responsibilities:
//   1. RSA-2048 key pair generation
//   2. PKCS#10 CSR generation (PEM) — sent to ZIMRA during RegisterDevice
//   3. x.509 certificate parsing & validation
//   4. Canonical receipt string construction & SHA-256 hashing
//   5. RSA-PKCS1v15 SHA-256 receipt signing (private key)
//   6. ZIMRA signature verification (public key / cert)
//   7. AES-256-GCM encryption/decryption for private key storage at rest
// =============================================================================
// Dependencies: Node.js built-in `crypto` module only — zero third-party libs.
// Node.js >= 18 required for generateKeyPairSync with RSA-PSS & x509 support.
// =============================================================================

import {
  createSign,
  createVerify,
  createHash,
  generateKeyPairSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "crypto";

import type {
  ZimraReceiptHashInput,
  ZimraDeviceSignature,
} from "../../types/zimra.js";

// ---------------------------------------------------------------------------
// §1. CONSTANTS
// ---------------------------------------------------------------------------

const RSA_KEY_SIZE = 2048;
const RSA_PUBLIC_EXPONENT = 65537;
const SIGN_ALGORITHM = "SHA256"; // RSA-PKCS1v15 with SHA-256 as per ZIMRA spec
const HASH_ALGORITHM = "sha256";
const AES_ALGORITHM = "aes-256-gcm";
const AES_KEY_BYTES = 32; // 256-bit
const AES_IV_BYTES = 12;  // 96-bit IV recommended for GCM
const AES_TAG_BYTES = 16; // 128-bit auth tag

// Canonical receipt hash field delimiter — ZIMRA FDMS developer guide §4.3
const CANONICAL_DELIMITER = "|";

// ---------------------------------------------------------------------------
// §2. TYPES
// ---------------------------------------------------------------------------

export interface GeneratedKeyPair {
  /** PEM-encoded RSA-2048 private key (PKCS#8 format). */
  privateKeyPem: string;
  /** PEM-encoded RSA-2048 public key (SubjectPublicKeyInfo format). */
  publicKeyPem: string;
}

export interface GeneratedCsr {
  /** PEM-encoded PKCS#10 certificate signing request. */
  csrPem: string;
  /** The subject DN embedded in the CSR (for logging/audit). */
  subjectDn: string;
}

export interface ParsedCertificate {
  /** PEM-encoded x.509 certificate. */
  pem: string;
  /** Hex-encoded SHA-256 fingerprint (thumbprint). */
  thumbprint: string;
  /** Certificate subject common name (should equal deviceId). */
  subjectCn: string;
  /** Certificate issuer common name. */
  issuerCn: string;
  /** UTC Date the certificate becomes valid. */
  validFrom: Date;
  /** UTC Date the certificate expires. */
  validTo: Date;
  /** True if the certificate has expired. */
  isExpired: boolean;
  /** True if the certificate will expire within the given warning window. */
  isExpiringSoon: boolean;
}

export interface EncryptedPrivateKey {
  /** Base64-encoded AES-256-GCM ciphertext of the PEM private key. */
  ciphertext: string;
  /** Base64-encoded 96-bit IV. */
  iv: string;
  /** Base64-encoded 128-bit GCM authentication tag. */
  tag: string;
}

// ---------------------------------------------------------------------------
// §3. KEY PAIR GENERATION
// ---------------------------------------------------------------------------

/**
 * Generates an RSA-2048 key pair for a ZIMRA virtual fiscal device.
 *
 * The private key is returned in PKCS#8 PEM format and MUST be encrypted
 * at rest using `encryptPrivateKey()` before being stored in the database.
 *
 * The public key is returned in SubjectPublicKeyInfo (SPKI) PEM format
 * and is embedded in the CSR submitted to ZIMRA.
 *
 * @returns `GeneratedKeyPair` containing both PEM-encoded keys.
 */
export function generateDeviceKeyPair(): GeneratedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: RSA_KEY_SIZE,
    publicExponent: RSA_PUBLIC_EXPONENT,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  return {
    privateKeyPem: privateKey as string,
    publicKeyPem: publicKey as string,
  };
}

// ---------------------------------------------------------------------------
// §4. CSR GENERATION (PKCS#10)
// ---------------------------------------------------------------------------

/**
 * Constructs a PEM-encoded PKCS#10 Certificate Signing Request.
 *
 * ZIMRA requires the CSR Subject to include at minimum:
 *   CN = {deviceId}       — Must exactly match the ZIMRA device serial
 *   O  = {businessName}   — Registered business name (as per ZIMRA portal)
 *   C  = "ZW"             — Country code
 *
 * Node.js does not expose a native PKCS#10 builder, so we construct the
 * ASN.1 DER structure manually and PEM-encode it.
 *
 * ASN.1 PKCS#10 CertificationRequest structure (RFC 2986):
 *   CertificationRequest ::= SEQUENCE {
 *     certificationRequestInfo  CertificationRequestInfo,
 *     signatureAlgorithm        AlgorithmIdentifier,
 *     signature                 BIT STRING
 *   }
 *
 * @param deviceId      - ZIMRA device serial (used as CN).
 * @param businessName  - Registered business trading name.
 * @param privateKeyPem - PEM private key to sign the CSR.
 * @param city          - Optional city (L field in DN).
 * @returns `GeneratedCsr` with PEM string and subject DN.
 */
export function generateCsr(
  deviceId: string,
  businessName: string,
  privateKeyPem: string,
  city?: string
): GeneratedCsr {
  // Build the Subject Distinguished Name
  const subjectComponents: [string, string][] = [
    ["C", "ZW"],
    ["O", sanitizeDnValue(businessName)],
    ["CN", sanitizeDnValue(deviceId)],
  ];
  if (city) {
    subjectComponents.splice(2, 0, ["L", sanitizeDnValue(city)]);
  }
  const subjectDn = subjectComponents
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  // Encode subject as ASN.1 DER SEQUENCE of RDNs
  const subjectDer = encodeSubjectDer(subjectComponents);

  // Encode public key as ASN.1 SubjectPublicKeyInfo
  // We derive the public key from the private key then get its DER
  const publicKeyDer = derivePublicKeyDer(privateKeyPem);

  // Assemble CertificationRequestInfo (version=0, subject, subjectPKInfo, attributes=[])
  const certificationRequestInfo = encodeCertificationRequestInfo(
    subjectDer,
    publicKeyDer
  );

  // Sign CertificationRequestInfo with the private key (SHA-256 RSA)
  const signer = createSign("SHA256");
  signer.update(certificationRequestInfo);
  signer.end();
  const signatureDer = signer.sign({
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });

  // AlgorithmIdentifier for sha256WithRSAEncryption (OID 1.2.840.113549.1.1.11)
  const algorithmIdentifierDer = Buffer.from(
    "300d06092a864886f70d01010b0500",
    "hex"
  );

  // Encode signature as BIT STRING (prepend 0x00 for zero unused bits)
  const signatureBitString = encodeBitString(signatureDer);

  // Final CertificationRequest SEQUENCE
  const certificationRequest = encodeSequence(
    Buffer.concat([
      certificationRequestInfo,
      algorithmIdentifierDer,
      signatureBitString,
    ])
  );

  const csrPem = derToPem(certificationRequest, "CERTIFICATE REQUEST");

  return { csrPem, subjectDn };
}

// ---------------------------------------------------------------------------
// §5. CERTIFICATE PARSING & VALIDATION
// ---------------------------------------------------------------------------

/**
 * Parses a PEM-encoded x.509 certificate returned by ZIMRA after registration.
 * Extracts thumbprint, validity dates, and subject/issuer CNs.
 *
 * @param certPem           - PEM-encoded certificate from ZIMRA.
 * @param expiryWarningDays - Days before expiry to flag `isExpiringSoon` (default: 30).
 * @returns `ParsedCertificate` with all relevant fields.
 */
export function parseCertificate(
  certPem: string,
  expiryWarningDays = 30
): ParsedCertificate {
  const cert = new X509Certificate(certPem);

  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  const now = new Date();
  const warningThreshold = new Date(
    now.getTime() + expiryWarningDays * 24 * 60 * 60 * 1000
  );

  // Compute SHA-256 thumbprint (hex) from DER-encoded certificate
  const thumbprint = createHash(HASH_ALGORITHM)
    .update(cert.raw)
    .digest("hex");

  // Extract CN from subject string (format: "CN=value, O=org, C=ZW")
  const subjectCn = extractCn(cert.subject);
  const issuerCn = extractCn(cert.issuer);

  return {
    pem: certPem.trim(),
    thumbprint,
    subjectCn,
    issuerCn,
    validFrom,
    validTo,
    isExpired: now > validTo,
    isExpiringSoon: now < validTo && validTo <= warningThreshold,
  };
}

/**
 * Verifies that a ZIMRA-issued certificate is currently valid and
 * that its CN matches the expected device ID.
 *
 * @throws `Error` if the certificate is expired or CN mismatches.
 */
export function assertCertificateValid(
  certPem: string,
  expectedDeviceId: string
): void {
  const parsed = parseCertificate(certPem);

  if (parsed.isExpired) {
    throw new Error(
      `ZIMRA device certificate expired on ${parsed.validTo.toISOString()}. ` +
        `Re-register the device to obtain a new certificate.`
    );
  }

  if (parsed.subjectCn !== expectedDeviceId) {
    throw new Error(
      `Certificate CN mismatch: expected "${expectedDeviceId}", ` +
        `got "${parsed.subjectCn}". Certificate may belong to a different device.`
    );
  }
}

// ---------------------------------------------------------------------------
// §6. RECEIPT CANONICAL STRING & SHA-256 HASH
// ---------------------------------------------------------------------------

/**
 * Constructs the canonical receipt string used as input to the SHA-256 hash.
 *
 * ZIMRA FDMS canonical format (§4.3 of the developer guide):
 *   {deviceID}|{fiscalDayNo}|{receiptCounter}|{receiptDate}|{receiptTotal}|
 *   {receiptCurrency}|{previousReceiptGlobalNo}
 *
 * Rules:
 *   - `receiptDate` must be an ISO 8601 UTC string (e.g., "2024-07-01T08:30:00Z")
 *   - `receiptTotal` is formatted to exactly 2 decimal places
 *   - No trailing delimiter
 *
 * @param input - `ZimraReceiptHashInput` as defined in types/zimra.ts.
 * @returns The raw canonical string (for audit/debug).
 */
export function buildCanonicalReceiptString(
  input: ZimraReceiptHashInput
): string {
  const parts: string[] = [
    input.deviceId,
    String(input.fiscalDayNo),
    String(input.receiptCounter),
    normaliseIsoDate(input.receiptDate),
    input.receiptTotal.toFixed(2),
    input.receiptCurrency,
    String(input.previousReceiptGlobalNo),
  ];
  return parts.join(CANONICAL_DELIMITER);
}

/**
 * Computes the SHA-256 hash of the canonical receipt string.
 *
 * @param input - `ZimraReceiptHashInput`.
 * @returns Hex-encoded SHA-256 digest (64 characters).
 */
export function hashReceipt(input: ZimraReceiptHashInput): string {
  const canonical = buildCanonicalReceiptString(input);
  return createHash(HASH_ALGORITHM).update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// §7. RSA RECEIPT SIGNING
// ---------------------------------------------------------------------------

/**
 * Signs the SHA-256 receipt hash with the device RSA-2048 private key
 * using PKCS#1 v1.5 padding (as required by ZIMRA FDMS §4.4).
 *
 * The input `hash` (hex string from `hashReceipt()`) is re-hashed inside
 * `createSign` — Node.js's `sign.update()` accepts raw data and handles
 * the internal SHA-256 digest computation automatically when the algorithm
 * is specified as "SHA256".
 *
 * @param hashHex       - Hex-encoded SHA-256 receipt hash from `hashReceipt()`.
 * @param privateKeyPem - PEM-encoded RSA-2048 private key (PKCS#8).
 * @returns `ZimraDeviceSignature` with `hash` (hex) and `signature` (Base64).
 */
export function signReceipt(
  hashHex: string,
  privateKeyPem: string
): ZimraDeviceSignature {
  // ZIMRA expects the signature to be over the raw canonical string
  // We sign the hash bytes (decoded from hex) to match ZIMRA's verification
  const hashBuffer = Buffer.from(hashHex, "hex");

  const signer = createSign(SIGN_ALGORITHM);
  signer.update(hashBuffer);
  signer.end();

  const signatureBuffer = signer.sign({
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
    padding: 1, // RSA_PKCS1_PADDING = 1
  });

  return {
    hash: hashHex,
    signature: signatureBuffer.toString("base64"),
  };
}

/**
 * Convenience function that performs the full sign flow in one call:
 * 1. Builds canonical string from `input`
 * 2. Computes SHA-256 hash
 * 3. Signs the hash with the private key
 *
 * @param input         - `ZimraReceiptHashInput`.
 * @param privateKeyPem - PEM-encoded RSA-2048 private key.
 * @returns `ZimraDeviceSignature` ready to embed in `ZimraSubmitReceiptRequest`.
 */
export function buildReceiptSignature(
  input: ZimraReceiptHashInput,
  privateKeyPem: string
): ZimraDeviceSignature {
  const hashHex = hashReceipt(input);
  return signReceipt(hashHex, privateKeyPem);
}

// ---------------------------------------------------------------------------
// §8. SIGNATURE VERIFICATION
// ---------------------------------------------------------------------------

/**
 * Verifies a ZIMRA device signature using the device's RSA public key.
 * Used when re-validating locally stored receipts or for audit purposes.
 *
 * @param signature     - `ZimraDeviceSignature` from the stored receipt.
 * @param publicKeyPem  - PEM-encoded RSA-2048 public key.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyReceiptSignature(
  signature: ZimraDeviceSignature,
  publicKeyPem: string
): boolean {
  try {
    const hashBuffer = Buffer.from(signature.hash, "hex");
    const signatureBuffer = Buffer.from(signature.signature, "base64");

    const verifier = createVerify(SIGN_ALGORITHM);
    verifier.update(hashBuffer);
    verifier.end();

    return verifier.verify(
      { key: publicKeyPem, format: "pem", type: "spki" },
      signatureBuffer
    );
  } catch {
    // Any crypto error (malformed key, invalid base64) = invalid signature
    return false;
  }
}

/**
 * Verifies a ZIMRA server-side fiscal signature using ZIMRA's CA public key.
 * The ZIMRA CA public key is extracted from the server certificate obtained
 * via `GetServerCertificate`.
 *
 * @param receiptQrUrl      - The raw QR URL string returned by SubmitReceipt.
 * @param fiscalSignature   - Base64-encoded ZIMRA server signature.
 * @param zimraCaCertPem    - PEM-encoded ZIMRA CA certificate.
 * @returns `true` if ZIMRA's signature is valid.
 */
export function verifyZimraFiscalSignature(
  receiptQrUrl: string,
  fiscalSignature: string,
  zimraCaCertPem: string
): boolean {
  try {
    const cert = new X509Certificate(zimraCaCertPem);
    const signatureBuffer = Buffer.from(fiscalSignature, "base64");

    const verifier = createVerify(SIGN_ALGORITHM);
    verifier.update(receiptQrUrl, "utf8");
    verifier.end();

    return verifier.verify(cert.publicKey, signatureBuffer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// §9. PRIVATE KEY ENCRYPTION AT REST (AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Encrypts a PEM private key using AES-256-GCM for secure database storage.
 *
 * The encryption key should be derived from an application-level secret
 * (e.g., from `process.env.DEVICE_KEY_ENCRYPTION_SECRET` via PBKDF2/HKDF)
 * and MUST NOT be stored in the database alongside the ciphertext.
 *
 * @param privateKeyPem   - Plaintext PEM private key.
 * @param encryptionKey   - 32-byte (256-bit) AES encryption key.
 * @returns `EncryptedPrivateKey` with ciphertext, iv, and auth tag (all Base64).
 */
export function encryptPrivateKey(
  privateKeyPem: string,
  encryptionKey: Buffer
): EncryptedPrivateKey {
  if (encryptionKey.length !== AES_KEY_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${AES_KEY_BYTES} bytes (256-bit). ` +
        `Got ${encryptionKey.length} bytes.`
    );
  }

  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, encryptionKey, iv, {
    authTagLength: AES_TAG_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(privateKeyPem, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypts a previously encrypted PEM private key.
 *
 * @param encrypted     - `EncryptedPrivateKey` from the database.
 * @param encryptionKey - 32-byte AES key (same one used during encryption).
 * @returns Plaintext PEM private key string.
 * @throws `Error` if authentication fails (key/IV mismatch or data tampered).
 */
export function decryptPrivateKey(
  encrypted: EncryptedPrivateKey,
  encryptionKey: Buffer
): string {
  if (encryptionKey.length !== AES_KEY_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${AES_KEY_BYTES} bytes. ` +
        `Got ${encryptionKey.length} bytes.`
    );
  }

  const iv = Buffer.from(encrypted.iv, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");

  const decipher = createDecipheriv(AES_ALGORITHM, encryptionKey, iv, {
    authTagLength: AES_TAG_BYTES,
  });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error(
      "AES-256-GCM authentication failed when decrypting private key. " +
        "The encryption key may be incorrect or the ciphertext has been tampered with."
    );
  }
}

/**
 * Derives a 32-byte AES-256 encryption key from a passphrase using PBKDF2.
 * Use this to derive the database encryption key from an environment variable.
 *
 * @param passphrase - The secret passphrase (from env var).
 * @param salt       - A fixed application-level salt (not per-record).
 * @returns 32-byte Buffer suitable for `encryptPrivateKey` / `decryptPrivateKey`.
 */
export function deriveEncryptionKey(
  passphrase: string,
  salt: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { pbkdf2 } = require("crypto");
    pbkdf2(
      passphrase,
      salt,
      310_000, // OWASP 2023 minimum iteration count for PBKDF2-SHA256
      AES_KEY_BYTES,
      "sha256",
      (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// §10. ASN.1 DER ENCODING UTILITIES (internal)
// ---------------------------------------------------------------------------

/**
 * Encodes a value as an ASN.1 DER TLV (tag, length, value) SEQUENCE.
 */
function encodeSequence(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x30]),
    encodeDerLength(content.length),
    content,
  ]);
}

/**
 * Encodes a Buffer as an ASN.1 BIT STRING (tag 0x03).
 * Prepends a 0x00 byte to indicate zero unused bits in the final octet.
 */
function encodeBitString(value: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from([0x00]), value]);
  return Buffer.concat([
    Buffer.from([0x03]),
    encodeDerLength(content.length),
    content,
  ]);
}

/**
 * Encodes an ASN.1 DER length field (supports short and long form).
 */
function encodeDerLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  if (length < 256) {
    return Buffer.from([0x81, length]);
  }
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

/**
 * Encodes a UTF-8 string as an ASN.1 UTF8String (tag 0x0C).
 */
function encodeUtf8String(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([
    Buffer.from([0x0c]),
    encodeDerLength(content.length),
    content,
  ]);
}

/**
 * Encodes an OID string (e.g., "2.5.4.3") as ASN.1 DER OBJECT IDENTIFIER.
 */
function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const encoded: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const bytes: number[] = [val & 0x7f];
    val >>= 7;
    while (val > 0) {
      bytes.unshift((val & 0x7f) | 0x80);
      val >>= 7;
    }
    encoded.push(...bytes);
  }
  const content = Buffer.from(encoded);
  return Buffer.concat([
    Buffer.from([0x06]),
    encodeDerLength(content.length),
    content,
  ]);
}

// Standard X.509 attribute OIDs
const DN_OIDS: Record<string, string> = {
  CN: "2.5.4.3",
  O: "2.5.4.10",
  L: "2.5.4.7",
  C: "2.5.4.6",
};

/**
 * Encodes a Subject Distinguished Name as ASN.1 DER SEQUENCE of RDNs.
 */
function encodeSubjectDer(components: [string, string][]): Buffer {
  const rdns = components.map(([attr, value]) => {
    const oidDer = encodeOid(DN_OIDS[attr]);
    const valueDer =
      attr === "C"
        ? encodePrintableString(value)
        : encodeUtf8String(value);

    // AttributeTypeAndValue ::= SEQUENCE { type OID, value ANY }
    const attrSeq = encodeSequence(Buffer.concat([oidDer, valueDer]));
    // RelativeDistinguishedName ::= SET OF AttributeTypeAndValue
    return encodeSet(attrSeq);
  });

  return encodeSequence(Buffer.concat(rdns));
}

/**
 * Encodes a string as ASN.1 PrintableString (tag 0x13).
 * Used for the Country (C) DN attribute.
 */
function encodePrintableString(value: string): Buffer {
  const content = Buffer.from(value, "ascii");
  return Buffer.concat([
    Buffer.from([0x13]),
    encodeDerLength(content.length),
    content,
  ]);
}

/**
 * Encodes content as an ASN.1 SET (tag 0x31).
 */
function encodeSet(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x31]),
    encodeDerLength(content.length),
    content,
  ]);
}

/**
 * Encodes an ASN.1 INTEGER from a small non-negative number.
 */
function encodeSmallInt(value: number): Buffer {
  return Buffer.from([0x02, 0x01, value]);
}

/**
 * Derives the DER-encoded SubjectPublicKeyInfo from a PEM private key
 * by re-exporting just the public component.
 */
function derivePublicKeyDer(privateKeyPem: string): Buffer {
  const { createPublicKey } = require("crypto");
  const publicKey: KeyObject = createPublicKey({
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });
  return publicKey.export({ type: "spki", format: "der" }) as Buffer;
}

/**
 * Assembles the DER-encoded CertificationRequestInfo (version, subject, spki, attrs).
 */
function encodeCertificationRequestInfo(
  subjectDer: Buffer,
  publicKeyInfoDer: Buffer
): Buffer {
  // version INTEGER (0 = v1)
  const versionDer = encodeSmallInt(0);
  // attributes [0] IMPLICIT Attributes ::= SET {} (empty)
  const attributesDer = Buffer.from([0xa0, 0x00]);

  return encodeSequence(
    Buffer.concat([versionDer, subjectDer, publicKeyInfoDer, attributesDer])
  );
}

/**
 * Converts a DER Buffer to PEM format with the specified label.
 */
function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// §11. HELPER UTILITIES
// ---------------------------------------------------------------------------

/**
 * Extracts the CN value from an X.509 subject/issuer string.
 * Input format: "CN=value, O=org, C=ZW" or "C=ZW\nO=org\nCN=value"
 */
function extractCn(dnString: string): string {
  const match = dnString.match(/(?:^|[\n,])\s*CN=([^,\n]+)/);
  return match ? match[1].trim() : "";
}

/**
 * Sanitises a Distinguished Name attribute value by escaping special chars.
 * Per RFC 4514, the following must be escaped: , + " \ < > ; = # /
 */
function sanitizeDnValue(value: string): string {
  return value.replace(/[,+"\\<>;=#/]/g, "\\$&").trim();
}

/**
 * Normalises an ISO 8601 date string to UTC format with Z suffix.
 * ZIMRA requires UTC timestamps with the "Z" suffix in canonical strings.
 */
function normaliseIsoDate(dateString: string): string {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) {
    throw new Error(
      `Invalid date string for canonical receipt hash: "${dateString}". ` +
        `Must be a valid ISO 8601 datetime.`
    );
  }
  return d.toISOString();
}