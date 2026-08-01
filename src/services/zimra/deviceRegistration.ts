// =============================================================================
// ZIMRA Device Registration Orchestration Service
// src/services/zimra/deviceRegistration.ts
// =============================================================================
// Orchestrates the full device lifecycle:
//   1. Generate RSA-2048 key pair
//   2. Generate PKCS#10 CSR
//   3. Call ZIMRA RegisterDevice API
//   4. Parse and validate returned x.509 certificate
//   5. Encrypt private key for database storage
//   6. Persist everything to the Device record via Prisma
//   7. Handle certificate renewal when approaching expiry
// =============================================================================

import { PrismaClient, DeviceStatus } from "@prisma/client";

import {
  generateDeviceKeyPair,
  generateCsr,
  parseCertificate,
  assertCertificateValid,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveEncryptionKey,
  type EncryptedPrivateKey,
} from "./crypto.js";

import {
  createZimraClient,
  unwrapZimraResult,
  ZimraApiError,
} from "./client.js";

import type { ZimraClientConfig } from "../../types/zimra.js";

// ---------------------------------------------------------------------------
// §1. TYPES
// ---------------------------------------------------------------------------

export interface DeviceRegistrationInput {
  /** Internal database UUID of the device record. */
  deviceDbId: string;
  /** ZIMRA-assigned device serial (from operator portal). */
  deviceId: string;
  /** Activation key from the ZIMRA operator portal. */
  activationKey: string;
  /** Registered business name (embedded in the CSR Subject). */
  businessName: string;
  /** City for the CSR Subject L field (optional). */
  city?: string;
}

export interface DeviceRegistrationResult {
  /** The ZIMRA device serial. */
  deviceId: string;
  /** Hex SHA-256 thumbprint of the issued certificate. */
  certificateThumbprint: string;
  /** UTC expiry date of the issued certificate. */
  certExpiresAt: Date;
  /** True if registration was successful. */
  registered: boolean;
}

export interface DeviceCredentials {
  /** PEM-encoded RSA-2048 private key (plaintext — for in-memory use only). */
  privateKeyPem: string;
  /** PEM-encoded RSA-2048 public key. */
  publicKeyPem: string;
  /** PEM-encoded x.509 certificate from ZIMRA. */
  certificatePem: string;
  /** Hex SHA-256 thumbprint. */
  certificateThumbprint: string;
}

// ---------------------------------------------------------------------------
// §2. DEVICE REGISTRATION SERVICE
// ---------------------------------------------------------------------------

export class DeviceRegistrationService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Executes the full ZIMRA device registration flow.
   *
   * Steps:
   *   1. Validates the device exists in our DB and is in PENDING_ACTIVATION state.
   *   2. Generates a fresh RSA-2048 key pair.
   *   3. Generates a PKCS#10 CSR with the device's ZIMRA serial as the CN.
   *   4. Calls ZIMRA RegisterDevice API.
   *   5. Validates the returned x.509 certificate.
   *   6. Encrypts the private key using AES-256-GCM.
   *   7. Persists all cryptographic material to the Device record.
   *   8. Updates Device.status to ACTIVE.
   *
   * This method is idempotent — if called on an already-ACTIVE device
   * it will throw a `DeviceAlreadyRegisteredError`.
   *
   * @param input - Device registration parameters.
   * @returns `DeviceRegistrationResult` on success.
   */
  async registerDevice(
    input: DeviceRegistrationInput
  ): Promise<DeviceRegistrationResult> {
    // ── Step 1: Validate device state ──────────────────────────────────────
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: input.deviceDbId },
      select: {
        id: true,
        deviceId: true,
        status: true,
        tenant: {
          select: { businessName: true, city: true },
        },
      },
    });

    if (device.status === DeviceStatus.ACTIVE) {
      throw new DeviceAlreadyRegisteredError(
        `Device "${input.deviceId}" is already registered with ZIMRA (status: ACTIVE). ` +
          `Use renewCertificate() to renew an expiring certificate.`
      );
    }

    if (device.status === DeviceStatus.DECOMMISSIONED) {
      throw new Error(
        `Device "${input.deviceId}" has been decommissioned and cannot be re-registered.`
      );
    }

    // ── Step 2: Generate RSA-2048 key pair ─────────────────────────────────
    const { privateKeyPem, publicKeyPem } = generateDeviceKeyPair();

    // ── Step 3: Generate PKCS#10 CSR ───────────────────────────────────────
    const { csrPem, subjectDn } = generateCsr(
      input.deviceId,
      input.businessName,
      privateKeyPem,
      input.city ?? device.tenant.city ?? undefined
    );

    // ── Step 4: Call ZIMRA RegisterDevice ──────────────────────────────────
    const zimraConfig: ZimraClientConfig = {
      baseUrl: "", // Will be set by createZimraClient from env
      deviceId: input.deviceId,
      privateKeyPem,            // Not used for RegisterDevice (pre-cert)
      certificatePem: "",       // Not yet issued
      certificateThumbprint: "", // Not yet known
    };
    const client = createZimraClient(zimraConfig);

    let certPem: string;
    let certThumbprint: string;
    let certValidTill: string;

    try {
      const registrationResponse = unwrapZimraResult(
        await client.registerDevice(input.activationKey, csrPem)
      );
      certPem = registrationResponse.certificate;
      certThumbprint = registrationResponse.certificateThumbprint;
      certValidTill = registrationResponse.certificateValidTill;
    } catch (error) {
      if (error instanceof ZimraApiError) {
        throw new DeviceRegistrationFailedError(
          `ZIMRA rejected device registration for "${input.deviceId}": ` +
            `[${error.errorCode}] ${error.errorMessage}`,
          error
        );
      }
      throw error;
    }

    // ── Step 5: Validate the returned certificate ──────────────────────────
    const parsedCert = parseCertificate(certPem);
    assertCertificateValid(certPem, input.deviceId);

    // Verify ZIMRA's thumbprint matches our own computation
    if (
      parsedCert.thumbprint.toLowerCase() !== certThumbprint.toLowerCase()
    ) {
      throw new Error(
        `Certificate thumbprint mismatch: ZIMRA returned "${certThumbprint}" ` +
          `but computed "${parsedCert.thumbprint}". Possible MITM — aborting registration.`
      );
    }

    // ── Step 6: Encrypt private key ────────────────────────────────────────
    const encryptionKey = await getDeviceKeyEncryptionKey();
    const encryptedKey = encryptPrivateKey(privateKeyPem, encryptionKey);

    // Serialise the encrypted key to a single JSON string for DB storage
    const privateKeyStored = JSON.stringify(encryptedKey);

    // ── Step 7 & 8: Persist to database ────────────────────────────────────
    await this.prisma.device.update({
      where: { id: input.deviceDbId },
      data: {
        status: DeviceStatus.ACTIVE,
        privateKeyPem: privateKeyStored,   // AES-256-GCM encrypted JSON
        publicKeyPem,
        csrPem,
        certificatePem: certPem,
        certificateThumb: parsedCert.thumbprint,
        certIssuedAt: parsedCert.validFrom,
        certExpiresAt: parsedCert.validTo,
        integrationKey: buildIntegrationKey(
          input.deviceId,
          parsedCert.thumbprint
        ),
      },
    });

    return {
      deviceId: input.deviceId,
      certificateThumbprint: parsedCert.thumbprint,
      certExpiresAt: parsedCert.validTo,
      registered: true,
    };
  }

  // ---------------------------------------------------------------------------
  // §3. LOAD DEVICE CREDENTIALS (decrypt for use)
  // ---------------------------------------------------------------------------

  /**
   * Loads and decrypts a device's cryptographic credentials from the database.
   * Returns in-memory `DeviceCredentials` for use by the ZIMRA client.
   *
   * NEVER persist the decrypted `privateKeyPem` — use it transiently for
   * signing operations only.
   *
   * @param deviceDbId - Internal database UUID of the device.
   * @throws `DeviceNotReadyError` if the device is not in ACTIVE status.
   */
  async loadDeviceCredentials(
    deviceDbId: string
  ): Promise<DeviceCredentials> {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceDbId },
      select: {
        deviceId: true,
        status: true,
        privateKeyPem: true,
        publicKeyPem: true,
        certificatePem: true,
        certificateThumb: true,
        certExpiresAt: true,
      },
    });

    if (device.status !== DeviceStatus.ACTIVE) {
      throw new DeviceNotReadyError(
        `Device "${device.deviceId}" is not active (status: ${device.status}). ` +
          `Only ACTIVE devices can process fiscal transactions.`
      );
    }

    if (
      !device.privateKeyPem ||
      !device.publicKeyPem ||
      !device.certificatePem ||
      !device.certificateThumb
    ) {
      throw new DeviceNotReadyError(
        `Device "${device.deviceId}" is missing cryptographic material. ` +
          `The device may not have completed ZIMRA registration.`
      );
    }

    // Validate certificate is still valid before returning credentials
    assertCertificateValid(device.certificatePem, device.deviceId);

    // Warn if expiring soon (within 30 days)
    const parsed = parseCertificate(device.certificatePem);
    if (parsed.isExpiringSoon) {
      console.warn(
        `[ZIMRA] Device "${device.deviceId}" certificate expires on ` +
          `${parsed.validTo.toISOString()}. Initiate certificate renewal.`
      );
    }

    // Decrypt private key
    const encryptionKey = await getDeviceKeyEncryptionKey();
    const encryptedKey: EncryptedPrivateKey = JSON.parse(device.privateKeyPem);
    const privateKeyPem = decryptPrivateKey(encryptedKey, encryptionKey);

    return {
      privateKeyPem,
      publicKeyPem: device.publicKeyPem,
      certificatePem: device.certificatePem,
      certificateThumbprint: device.certificateThumb,
    };
  }

  // ---------------------------------------------------------------------------
  // §4. CERTIFICATE RENEWAL
  // ---------------------------------------------------------------------------

  /**
   * Renews an expiring device certificate by generating a new key pair and
   * re-registering with ZIMRA using the same device serial.
   *
   * Call this when `parsedCert.isExpiringSoon === true` (within 30 days of expiry).
   *
   * A new activation key from the ZIMRA portal is required for renewal.
   * The fiscal history is preserved — only the cryptographic material changes.
   *
   * @param deviceDbId    - Internal database UUID.
   * @param activationKey - New activation key from ZIMRA portal.
   */
  async renewCertificate(
    deviceDbId: string,
    activationKey: string
  ): Promise<DeviceRegistrationResult> {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceDbId },
      select: {
        deviceId: true,
        status: true,
        tenant: { select: { businessName: true, city: true } },
      },
    });

    // Temporarily set to PENDING_ACTIVATION to allow re-registration
    await this.prisma.device.update({
      where: { id: deviceDbId },
      data: { status: DeviceStatus.PENDING_ACTIVATION },
    });

    try {
      return await this.registerDevice({
        deviceDbId,
        deviceId: device.deviceId,
        activationKey,
        businessName: device.tenant.businessName,
        city: device.tenant.city ?? undefined,
      });
    } catch (error) {
      // Restore previous status on failure
      await this.prisma.device.update({
        where: { id: deviceDbId },
        data: { status: device.status },
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // §5. DEVICE STATUS CHECK
  // ---------------------------------------------------------------------------

  /**
   * Checks whether the device certificate is valid and not expiring soon.
   * Returns a structured health report for the device's cryptographic state.
   */
  async checkDeviceCertificateHealth(deviceDbId: string): Promise<{
    isValid: boolean;
    isExpired: boolean;
    isExpiringSoon: boolean;
    expiresAt: Date | null;
    daysUntilExpiry: number | null;
    thumbprint: string | null;
  }> {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceDbId },
      select: {
        certificatePem: true,
        certificateThumb: true,
        certExpiresAt: true,
        status: true,
      },
    });

    if (!device.certificatePem) {
      return {
        isValid: false,
        isExpired: false,
        isExpiringSoon: false,
        expiresAt: null,
        daysUntilExpiry: null,
        thumbprint: null,
      };
    }

    const parsed = parseCertificate(device.certificatePem);
    const now = new Date();
    const msUntilExpiry = parsed.validTo.getTime() - now.getTime();
    const daysUntilExpiry = Math.floor(msUntilExpiry / (1000 * 60 * 60 * 24));

    return {
      isValid: !parsed.isExpired,
      isExpired: parsed.isExpired,
      isExpiringSoon: parsed.isExpiringSoon,
      expiresAt: parsed.validTo,
      daysUntilExpiry: parsed.isExpired ? null : daysUntilExpiry,
      thumbprint: parsed.thumbprint,
    };
  }
}

// ---------------------------------------------------------------------------
// §6. PRIVATE HELPERS
// ---------------------------------------------------------------------------

/**
 * Builds the ZIMRA integration key (Bearer token credential) from deviceId
 * and certificate thumbprint. Stored in Device.integrationKey for quick access.
 *
 * Format: base64("{deviceId}:{thumbprint}")
 */
function buildIntegrationKey(deviceId: string, thumbprint: string): string {
  return Buffer.from(`${deviceId}:${thumbprint}`, "utf8").toString("base64");
}

/**
 * Derives the 32-byte AES-256 encryption key from environment variables.
 * Called lazily — key derivation (PBKDF2) is intentionally expensive.
 *
 * Required env vars:
 *   DEVICE_KEY_SECRET — The master passphrase (min 32 chars recommended)
 *   DEVICE_KEY_SALT   — A fixed application-level salt (not per-device)
 */
async function getDeviceKeyEncryptionKey(): Promise<Buffer> {
  const passphrase = process.env.DEVICE_KEY_SECRET;
  const salt = process.env.DEVICE_KEY_SALT;

  if (!passphrase || !salt) {
    throw new Error(
      "Missing required environment variables: DEVICE_KEY_SECRET and DEVICE_KEY_SALT " +
        "must be set to encrypt/decrypt device private keys."
    );
  }

  if (passphrase.length < 32) {
    throw new Error(
      "DEVICE_KEY_SECRET must be at least 32 characters long for adequate security."
    );
  }

  const { deriveEncryptionKey } = await import("./crypto.js");
  return deriveEncryptionKey(passphrase, salt);
}

// ---------------------------------------------------------------------------
// §7. CUSTOM ERROR CLASSES
// ---------------------------------------------------------------------------

export class DeviceAlreadyRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAlreadyRegisteredError";
  }
}

export class DeviceRegistrationFailedError extends Error {
  constructor(
    message: string,
    public readonly cause: ZimraApiError
  ) {
    super(message);
    this.name = "DeviceRegistrationFailedError";
  }
}

export class DeviceNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotReadyError";
  }
}