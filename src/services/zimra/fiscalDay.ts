// =============================================================================
// ZIMRA Fiscal Day & Receipt Submission Service
// src/services/zimra/fiscalDay.ts
// =============================================================================
// Orchestrates:
//   - OpenDay flow (state validation → API call → DB update)
//   - Receipt submission (hash → sign → submit → store QR)
//   - CloseDay / Z-Report aggregation flow
//   - QR code verification URL construction
//   - Fiscal counter management (monotonic, per-device)
// =============================================================================

import {
  PrismaClient,
  FiscalDayStatus,
  SaleStatus,
  type Sale,
  type FiscalDay,
  type Device,
} from "../../../generated/prisma/index.js";

import { buildReceiptSignature, hashReceipt } from "./crypto.js";
import {
  createZimraClient,
  isZimraSuccess,
  ZimraApiError,
} from "./client.js";
import { DeviceRegistrationService } from "./deviceRegistration.js";
import { randomUUID } from "crypto";

import type {
  ZimraSubmitReceiptRequest,
  ZimraCloseDayRequest,
  ZimraReceiptLine,
  ZimraReceiptTax,
  ZimraReceiptPayment,
  ZimraDayTaxSummary,
  ZimraDayPaymentSummary,
  ZimraReceiptHashInput,
  ZimraTaxCategory,
  ZimraPaymentType,
  ZimraResult,
  ZimraOpenDayResponse,
  ZimraSubmitReceiptResponse,
  ZimraCloseDayResponse,
  ZimraZReport,
  ZimraCurrencyCode,
} from "../../types/zimra.js";

// ---------------------------------------------------------------------------
// §1. TYPES
// ---------------------------------------------------------------------------

export interface OpenDayInput {
  deviceDbId: string;
  tenantId: string;
  openedByUserId: string;
}

export interface OpenDayResult {
  fiscalDayDbId: string;
  fiscalDayNo: number;
  fiscalDayDate: string;         // ISO date "YYYY-MM-DD"
  zimraToken: string;
  openedAt: Date;
  /** True if the OpenDay was deferred to the offline sync queue. */
  queued: boolean;
}

export interface SubmitReceiptInput {
  saleDbId: string;
  deviceDbId: string;
  fiscalDayDbId: string;
  tenantId: string;
}

export interface SubmitReceiptResult {
  receiptGlobalNo: number;
  receiptQrUrl: string;
  verificationCode: string;
  fiscalSignature: string;
  /** True if the submission was deferred to the offline sync queue. */
  queued: boolean;
}

export interface CloseDayInput {
  fiscalDayDbId: string;
  deviceDbId: string;
  tenantId: string;
  closedByUserId: string;
}

export interface CloseDayResult {
  fiscalDayNo: number;
  zimraToken: string;
  closedAt: Date;
  zReport: ZimraZReport;
  /** True if close was deferred to offline sync queue. */
  queued: boolean;
}

// ---------------------------------------------------------------------------
// §2. FISCAL DAY SERVICE
// ---------------------------------------------------------------------------

export class FiscalDayService {
  private readonly prisma: PrismaClient;
  private readonly registrationService: DeviceRegistrationService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.registrationService = new DeviceRegistrationService(prisma);
  }

  // ---------------------------------------------------------------------------
  // §3. OPEN FISCAL DAY
  // ---------------------------------------------------------------------------

  /**
   * Opens a new fiscal day for a device.
   *
   * Validation performed before API call:
   *   - Device must be ACTIVE
   *   - No existing OPEN FiscalDay for this device today
   *   - A CurrencyRate (ZiG/USD) must exist for today
   *
   * If the ZIMRA API call fails due to network issues, the OpenDay operation
   * is queued in OfflineSyncQueue for automatic retry.
   */
  async openDay(input: OpenDayInput): Promise<OpenDayResult> {
    // ── Validate device ────────────────────────────────────────────────────
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: input.deviceDbId },
      select: {
        id: true,
        deviceId: true,
        status: true,
        lastFiscalDayNo: true,
        tenantId: true,
      },
    });

    assertDeviceActive(device);

    // ── Check for existing open day ────────────────────────────────────────
    const today = getTodayDate();
    const existingOpenDay = await this.prisma.fiscalDay.findFirst({
      where: {
        deviceId: input.deviceDbId,
        status: FiscalDayStatus.OPEN,
      },
    });

    if (existingOpenDay) {
      throw new FiscalDayAlreadyOpenError(
        `Device "${device.deviceId}" already has an open fiscal day ` +
          `(Day #${existingOpenDay.fiscalDayNo}, opened ${existingOpenDay.openedAt?.toISOString()}). ` +
          `Close the current day before opening a new one.`
      );
    }

    // ── Validate currency rate exists for today ────────────────────────────
    const currencyRate = await this.prisma.currencyRate.findFirst({
      where: {
        tenantId: input.tenantId,
        rateDate: today,
        fromCurrency: "USD",
        toCurrency: "ZIG",
      },
    });

    if (!currencyRate) {
      throw new MissingCurrencyRateError(
        `No ZiG/USD exchange rate found for ${today.toISOString().split("T")[0]}. ` +
          `Set today's RBZ exchange rate before opening the fiscal day.`
      );
    }

    // ── Compute next fiscal day number ─────────────────────────────────────
    const nextFiscalDayNo = device.lastFiscalDayNo + 1;
    const openedAt = new Date();
    const idempotencyKey = randomUUID();

    // ── Create FiscalDay record (OPEN status — optimistic) ─────────────────
    const fiscalDay = await this.prisma.fiscalDay.create({
      data: {
        tenantId: input.tenantId,
        deviceId: input.deviceDbId,
        openedById: input.openedByUserId,
        fiscalDayNo: nextFiscalDayNo,
        fiscalDayDate: today,
        status: FiscalDayStatus.OPEN,
        openedAt,
        openRequestPayload: {
          fiscalDayNo: nextFiscalDayNo,
          fiscalDayOpened: openedAt.toISOString(),
        },
      },
    });

    // ── Call ZIMRA OpenDay API ─────────────────────────────────────────────
    const credentials = await this.registrationService.loadDeviceCredentials(
      input.deviceDbId
    );
    const client = createZimraClient({
      baseUrl: "",
      deviceId: device.deviceId,
      privateKeyPem: credentials.privateKeyPem,
      certificatePem: credentials.certificatePem,
      certificateThumbprint: credentials.certificateThumbprint,
    });

    const zimraResult = await client.openDay(
      nextFiscalDayNo,
      openedAt,
      idempotencyKey
    );

    if (isZimraSuccess(zimraResult)) {
      // ── Update FiscalDay and Device counters on success ─────────────────
      const response = zimraResult.data;
      await this.prisma.$transaction([
        this.prisma.fiscalDay.update({
          where: { id: fiscalDay.id },
          data: {
            zimraOpenToken: response.fiscalDayOpenedToken,
            openResponsePayload: response as object,
          },
        }),
        this.prisma.device.update({
          where: { id: input.deviceDbId },
          data: { lastFiscalDayNo: nextFiscalDayNo },
        }),
      ]);

      return {
        fiscalDayDbId: fiscalDay.id,
        fiscalDayNo: nextFiscalDayNo,
        fiscalDayDate: toDateString(today),
        zimraToken: response.fiscalDayOpenedToken,
        openedAt,
        queued: false,
      };
    }

    // ── ZIMRA rejection — queue for retry and return with queued=true ──────
    await this.queueOperation({
      tenantId: input.tenantId,
      deviceDbId: input.deviceDbId,
      operationType: "OPEN_DAY",
      entityType: "FiscalDay",
      entityId: fiscalDay.id,
      idempotencyKey,
      payload: {
        fiscalDayNo: nextFiscalDayNo,
        fiscalDayOpened: openedAt.toISOString(),
      },
    });

    return {
      fiscalDayDbId: fiscalDay.id,
      fiscalDayNo: nextFiscalDayNo,
      fiscalDayDate: toDateString(today),
      zimraToken: "",
      openedAt,
      queued: true,
    };
  }

  // ---------------------------------------------------------------------------
  // §4. SUBMIT RECEIPT
  // ---------------------------------------------------------------------------

  /**
   * Builds and submits a fiscal receipt to ZIMRA.
   *
   * Flow:
   *   1. Load Sale with all SaleItems from DB
   *   2. Load Device credentials
   *   3. Build canonical ZimraSubmitReceiptRequest
   *   4. Compute SHA-256 hash of canonical receipt string
   *   5. Sign the hash with device private key
   *   6. Submit to ZIMRA
   *   7. Store ZIMRA QR code and signature in Sale record
   *   8. On failure — queue in OfflineSyncQueue
   */
  async submitReceipt(
    input: SubmitReceiptInput
  ): Promise<SubmitReceiptResult> {
    // ── Load Sale with items ───────────────────────────────────────────────
    const sale = await this.prisma.sale.findUniqueOrThrow({
      where: { id: input.saleDbId },
      include: {
        items: { orderBy: { lineOrder: "asc" } },
        fiscalDay: true,
        device: true,
      },
    });

    if (!sale.fiscalDay) {
      throw new Error(
        `Sale "${input.saleDbId}" is not associated with an open fiscal day.`
      );
    }

    if (sale.fiscalDay.status !== FiscalDayStatus.OPEN) {
      throw new FiscalDayNotOpenError(
        `Cannot submit receipt — fiscal day #${sale.fiscalDay.fiscalDayNo} ` +
          `is in status "${sale.fiscalDay.status}" (must be OPEN).`
      );
    }

    // ── Load device credentials ────────────────────────────────────────────
    const credentials = await this.registrationService.loadDeviceCredentials(
      input.deviceDbId
    );

    // ── Determine next receipt counter ─────────────────────────────────────
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: input.deviceDbId },
      select: {
        deviceId: true,
        lastReceiptCounter: true,
        lastReceiptGlobalNo: true,
      },
    });
    const nextReceiptCounter = device.lastReceiptCounter + 1;
    const previousReceiptGlobalNo = device.lastReceiptGlobalNo;

    // ── Determine receipt currency ─────────────────────────────────────────
    // If customer paid entirely in ZiG, submit as ZIG; otherwise USD
    const payments: Array<{ method: string; amountUsd: number; amountZig: number }> =
      Array.isArray(sale.payments) ? (sale.payments as any[]) : [];
    const receiptCurrency = determineReceiptCurrency(payments);

    // ── Build receipt date ─────────────────────────────────────────────────
    const receiptDate = sale.createdAt.toISOString();

    // ── Build hash input ───────────────────────────────────────────────────
    const hashInput: ZimraReceiptHashInput = {
      deviceId: device.deviceId,
      fiscalDayNo: sale.fiscalDay.fiscalDayNo,
      receiptCounter: nextReceiptCounter,
      receiptDate,
      receiptTotal: Number(
        receiptCurrency === "USD" ? sale.grandTotalUsd : (sale.grandTotalZig ?? sale.grandTotalUsd)
      ),
      receiptCurrency,
      previousReceiptGlobalNo,
    };

    // ── Sign the receipt ───────────────────────────────────────────────────
    const deviceSignature = buildReceiptSignature(
      hashInput,
      credentials.privateKeyPem
    );

    // ── Build ZIMRA receipt lines ──────────────────────────────────────────
    const receiptLines: ZimraReceiptLine[] = sale.items.map((item: any, index: number) => ({
      receiptLineNo: index + 1,
      receiptLineName: item.productName.slice(0, 100),
      receiptLineQuantity: Number(item.quantity),
      receiptLinePrice: Number(item.unitPriceUsd),
      receiptLineTotal: Number(item.lineTotalUsd),
      taxRateCode: item.taxCategory as ZimraTaxCategory,
      receiptLineTaxPercent: Number(item.vatRate) * 100,
      ...(item.hsCode ? { hsCode: item.hsCode } : {}),
    }));

    // ── Build ZIMRA receipt taxes (aggregated by category) ─────────────────
    const receiptTaxes: ZimraReceiptTax[] = aggregateTaxesByCategory(
      sale.items.map((item: any) => ({
        taxCategory: item.taxCategory as ZimraTaxCategory,
        lineTotalUsd: Number(item.lineTotalUsd),
        vatAmountUsd: Number(item.vatAmountUsd),
        taxableAmountUsd: Number(item.taxableAmountUsd),
      }))
    );

    // ── Build ZIMRA payments ───────────────────────────────────────────────
    const receiptPayments: ZimraReceiptPayment[] = buildZimraPayments(
      payments,
      receiptCurrency
    );

    // ── Construct full SubmitReceipt request ───────────────────────────────
    const submitRequest: ZimraSubmitReceiptRequest = {
      receiptCounter: nextReceiptCounter,
      receiptGlobalNo: previousReceiptGlobalNo,
      receiptType: mapReceiptType(sale.receiptType),
      receiptDate,
      fiscalDayNo: sale.fiscalDay.fiscalDayNo,
      receiptCurrency,
      ...(receiptCurrency === "ZIG" && sale.exchangeRateUsed
        ? { receiptExchangeRate: Number(sale.exchangeRateUsed) }
        : {}),
      invoiceAmount: Number(sale.subtotalUsd) - Number(sale.discountUsd),
      receiptTotal: Number(sale.grandTotalUsd),
      receiptTaxes,
      receiptLines,
      receiptPayments,
      receiptDeviceSignature: deviceSignature,
      ...(sale.customerName ? { buyerName: sale.customerName } : {}),
      ...(sale.customerTinNumber ? { buyerTIN: sale.customerTinNumber } : {}),
      ...(sale.customerVatNumber ? { buyerVATNumber: sale.customerVatNumber } : {}),
      ...(sale.receiptType !== "FISCAL_INVOICE" && sale.referenceReceiptId
        ? {
            referenceReceiptNo: await this.getReferenceReceiptCounter(
              sale.referenceReceiptId
            ),
            referenceReceiptDate: (
              await this.getSaleDate(sale.referenceReceiptId)
            ).toISOString(),
          }
        : {}),
    };

    const idempotencyKey =
      sale.localIdempotencyKey ??
      `receipt-${sale.id}-${nextReceiptCounter}`;

    // ── Submit to ZIMRA ────────────────────────────────────────────────────
    const client = createZimraClient({
      baseUrl: "",
      deviceId: device.deviceId,
      privateKeyPem: credentials.privateKeyPem,
      certificatePem: credentials.certificatePem,
      certificateThumbprint: credentials.certificateThumbprint,
    });

    const zimraResult = await client.submitReceipt(
      submitRequest,
      idempotencyKey
    );

    if (isZimraSuccess(zimraResult)) {
      const response = zimraResult.data;
      const verifyUrl = buildVerifyUrl(response.receiptVerificationCode, device.deviceId);

      // ── Update Sale and Device in a single transaction ──────────────────
      await this.prisma.$transaction([
        this.prisma.sale.update({
          where: { id: input.saleDbId },
          data: {
            status: SaleStatus.FISCALLY_ACCEPTED,
            receiptCounter: nextReceiptCounter,
            receiptGlobalNo: response.receiptGlobalNo,
            fiscalHash: deviceSignature.hash,
            fiscalSignature: deviceSignature.signature,
            zimraQrCode: response.receiptQRUrl,
            zimraVerifyUrl: verifyUrl,
            zimraSubmittedAt: new Date(),
            zimraReceiptDate: new Date(response.receiptDate),
            zimraResponseCode: response.receiptResponseCode,
            submitRequestPayload: submitRequest as object,
            submitResponsePayload: response as object,
          },
        }),
        this.prisma.device.update({
          where: { id: input.deviceDbId },
          data: {
            lastReceiptCounter: nextReceiptCounter,
            lastReceiptGlobalNo: response.receiptGlobalNo,
          },
        }),
      ]);

      return {
        receiptGlobalNo: response.receiptGlobalNo,
        receiptQrUrl: response.receiptQRUrl,
        verificationCode: response.receiptVerificationCode,
        fiscalSignature: deviceSignature.signature,
        queued: false,
      };
    }

    // ── Failure — mark sale and queue for sync ─────────────────────────────
    const errorResult = zimraResult;
    const isDuplicate =
      errorResult.error.errorCode === "ERR_010";

    if (isDuplicate) {
      // ZIMRA already has this receipt — treat as success to unblock flow
      console.warn(
        `[ZIMRA] Duplicate receipt submission detected for Sale "${input.saleDbId}" ` +
          `(idempotency key: ${idempotencyKey}). Marking as accepted.`
      );
      await this.prisma.sale.update({
        where: { id: input.saleDbId },
        data: {
          status: SaleStatus.FISCALLY_ACCEPTED,
          receiptCounter: nextReceiptCounter,
          zimraResponseCode: "ERR_010_DUPLICATE",
          zimraSubmittedAt: new Date(),
        },
      });
      return {
        receiptGlobalNo: previousReceiptGlobalNo,
        receiptQrUrl: "",
        verificationCode: "",
        fiscalSignature: deviceSignature.signature,
        queued: false,
      };
    }

    // Queue for offline retry
    await this.prisma.$transaction([
      this.prisma.sale.update({
        where: { id: input.saleDbId },
        data: {
          status: SaleStatus.SYNC_PENDING,
          receiptCounter: nextReceiptCounter,
          fiscalHash: deviceSignature.hash,
          fiscalSignature: deviceSignature.signature,
          zimraResponseCode: errorResult.error.errorCode,
          zimraErrorMessage: errorResult.error.errorMessage,
          submitRequestPayload: submitRequest as object,
        },
      }),
      this.prisma.device.update({
        where: { id: input.deviceDbId },
        data: { lastReceiptCounter: nextReceiptCounter },
      }),
    ]);

    await this.queueOperation({
      tenantId: input.tenantId,
      deviceDbId: input.deviceDbId,
      operationType: "SUBMIT_RECEIPT",
      entityType: "Sale",
      entityId: input.saleDbId,
      idempotencyKey,
      payload: submitRequest as object,
    });

    return {
      receiptGlobalNo: 0,
      receiptQrUrl: "",
      verificationCode: "",
      fiscalSignature: deviceSignature.signature,
      queued: true,
    };
  }

  // ---------------------------------------------------------------------------
  // §5. CLOSE FISCAL DAY
  // ---------------------------------------------------------------------------

  /**
   * Closes the current fiscal day and generates the Z-Report.
   *
   * Flow:
   *   1. Validate all sales are fiscally accepted (no SYNC_PENDING)
   *   2. Aggregate Z-Report totals from all accepted sales
   *   3. Set FiscalDay status to CLOSE_INITIATED
   *   4. Submit CloseDay to ZIMRA
   *   5. On success — set status to CLOSED
   *   6. On failure — queue in OfflineSyncQueue
   */
  async closeDay(input: CloseDayInput): Promise<CloseDayResult> {
    // ── Load and validate fiscal day ───────────────────────────────────────
    const fiscalDay = await this.prisma.fiscalDay.findUniqueOrThrow({
      where: { id: input.fiscalDayDbId },
      include: {
        device: {
          select: { deviceId: true, lastReceiptGlobalNo: true },
        },
      },
    });

    if (fiscalDay.status !== FiscalDayStatus.OPEN) {
      throw new FiscalDayNotOpenError(
        `Fiscal day #${fiscalDay.fiscalDayNo} cannot be closed — ` +
          `current status is "${fiscalDay.status}".`
      );
    }

    // ── Check for pending sales ────────────────────────────────────────────
    const pendingSalesCount = await this.prisma.sale.count({
      where: {
        fiscalDayId: input.fiscalDayDbId,
        status: SaleStatus.SYNC_PENDING,
      },
    });

    if (pendingSalesCount > 0) {
      throw new PendingSalesError(
        `Cannot close fiscal day #${fiscalDay.fiscalDayNo} — ` +
          `${pendingSalesCount} sale(s) are still pending ZIMRA sync. ` +
          `Ensure all receipts are submitted before closing the day.`
      );
    }

    // ── Aggregate Z-Report from accepted sales ─────────────────────────────
    const zReport = await this.buildZReport(
      input.fiscalDayDbId,
      fiscalDay,
      fiscalDay.device
    );

    const closedAt = new Date();
    const idempotencyKey = randomUUID();

    // ── Build CloseDay request ─────────────────────────────────────────────
    const closeRequest: ZimraCloseDayRequest = {
      fiscalDayNo: fiscalDay.fiscalDayNo,
      fiscalDayClosed: closedAt.toISOString(),
      receiptCount: zReport.totalReceipts,
      fiscalDaySalesTotal: zReport.totalSalesUsd,
      fiscalDayTaxTotal: zReport.totalVatUsd,
      taxSummaries: zReport.taxBreakdown.map(
        (t): ZimraDayTaxSummary => ({
          taxCategory: t.taxCategory,
          totalSalesWithTax: t.salesWithTaxUsd,
          totalTaxAmount: t.taxAmountUsd,
        })
      ),
      paymentSummaries: zReport.paymentBreakdown.map(
        (p): ZimraDayPaymentSummary => ({
          moneyTypeCode: p.method,
          paymentAmount: p.totalUsd,
        })
      ),
      fiscalDayDiscountTotal: zReport.totalDiscountsUsd,
      fiscalDayRefundTotal: zReport.totalRefundsUsd,
      lastReceiptHash: zReport.lastReceiptHash,
    };

    // ── Update fiscal day to CLOSE_INITIATED ───────────────────────────────
    await this.prisma.fiscalDay.update({
      where: { id: input.fiscalDayDbId },
      data: {
        status: FiscalDayStatus.CLOSE_INITIATED,
        closeInitiatedAt: closedAt,
        closedById: input.closedByUserId,
        totalReceiptsCount: zReport.totalReceipts,
        totalSalesUsd: zReport.totalSalesUsd,
        totalSalesZig: zReport.totalSalesZig,
        totalVatUsd: zReport.totalVatUsd,
        totalVatZig: zReport.totalVatZig,
        totalDiscountsUsd: zReport.totalDiscountsUsd,
        totalRefundsUsd: zReport.totalRefundsUsd,
        closeRequestPayload: closeRequest as object,
      },
    });

    // ── Submit to ZIMRA ────────────────────────────────────────────────────
    const credentials = await this.registrationService.loadDeviceCredentials(
      input.deviceDbId
    );
    const client = createZimraClient({
      baseUrl: "",
      deviceId: fiscalDay.device.deviceId,
      privateKeyPem: credentials.privateKeyPem,
      certificatePem: credentials.certificatePem,
      certificateThumbprint: credentials.certificateThumbprint,
    });

    const zimraResult = await client.closeDay(closeRequest, idempotencyKey);

    if (isZimraSuccess(zimraResult)) {
      const response = zimraResult.data;

      await this.prisma.fiscalDay.update({
        where: { id: input.fiscalDayDbId },
        data: {
          status: FiscalDayStatus.CLOSED,
          closedAt,
          zimraCloseToken: response.fiscalDayClosedToken,
          closeResponsePayload: response as object,
        },
      });

      return {
        fiscalDayNo: fiscalDay.fiscalDayNo,
        zimraToken: response.fiscalDayClosedToken,
        closedAt,
        zReport,
        queued: false,
      };
    }

    // ── Failed — queue for retry and force-close locally ──────────────────
    await this.prisma.fiscalDay.update({
      where: { id: input.fiscalDayDbId },
      data: { status: FiscalDayStatus.FORCE_CLOSED },
    });

    await this.queueOperation({
      tenantId: input.tenantId,
      deviceDbId: input.deviceDbId,
      operationType: "CLOSE_DAY",
      entityType: "FiscalDay",
      entityId: input.fiscalDayDbId,
      idempotencyKey,
      payload: closeRequest as object,
    });

    return {
      fiscalDayNo: fiscalDay.fiscalDayNo,
      zimraToken: "",
      closedAt,
      zReport,
      queued: true,
    };
  }

  // ---------------------------------------------------------------------------
  // §6. Z-REPORT BUILDER
  // ---------------------------------------------------------------------------

  /**
   * Aggregates all accepted sales for a fiscal day into a `ZimraZReport`.
   * This is the authoritative Z-Report used for ZIMRA CloseDay submission
   * and for printing the end-of-day report.
   */
  async buildZReport(
    fiscalDayDbId: string,
    fiscalDay: FiscalDay & { device: Pick<Device, "deviceId" | "lastReceiptGlobalNo"> },
    device: Pick<Device, "deviceId" | "lastReceiptGlobalNo">
  ): Promise<ZimraZReport> {
    const acceptedSales = await this.prisma.sale.findMany({
      where: {
        fiscalDayId: fiscalDayDbId,
        status: SaleStatus.FISCALLY_ACCEPTED,
      },
      include: {
        items: true,
      },
      orderBy: { receiptCounter: "asc" },
    });

    // ── Aggregate totals ───────────────────────────────────────────────────
    let totalSalesUsd = 0;
    let totalSalesZig = 0;
    let totalVatUsd = 0;
    let totalVatZig = 0;
    let totalDiscountsUsd = 0;
    let totalRefundsUsd = 0;

    const taxMap = new Map<
      ZimraTaxCategory,
      { salesWithTaxUsd: number; taxAmountUsd: number; salesWithTaxZig: number; taxAmountZig: number }
    >();
    const paymentMap = new Map<ZimraPaymentType, { totalUsd: number; totalZig: number }>();

    for (const sale of acceptedSales) {
      const grandUsd = Number(sale.grandTotalUsd);
      const grandZig = Number(sale.grandTotalZig ?? 0);
      const vatUsd = Number(sale.vatTotalUsd);
      const discountUsd = Number(sale.discountUsd);
      const isRefund = sale.receiptType === "FISCAL_CREDIT_NOTE";

      totalSalesUsd += grandUsd;
      totalSalesZig += grandZig;
      totalVatUsd += vatUsd;
      totalVatZig += Number(sale.grandTotalZig ?? 0) > 0
        ? vatUsd * Number(sale.exchangeRateUsed ?? 1)
        : 0;
      totalDiscountsUsd += discountUsd;
      if (isRefund) totalRefundsUsd += grandUsd;

      // Per-item tax breakdown
      for (const item of sale.items) {
        const cat = item.taxCategory as ZimraTaxCategory;
        const existing = taxMap.get(cat) ?? {
          salesWithTaxUsd: 0,
          taxAmountUsd: 0,
          salesWithTaxZig: 0,
          taxAmountZig: 0,
        };
        existing.salesWithTaxUsd += Number(item.lineTotalUsd);
        existing.taxAmountUsd += Number(item.vatAmountUsd);
        taxMap.set(cat, existing);
      }

      // Payment breakdown
      const salePayments: Array<{ method: string; amountUsd: number; amountZig: number }> =
        Array.isArray(sale.payments) ? (sale.payments as any[]) : [];

      for (const pmt of salePayments) {
        const zimraMethod = mapPaymentMethod(pmt.method) as ZimraPaymentType;
        const existing = paymentMap.get(zimraMethod) ?? { totalUsd: 0, totalZig: 0 };
        existing.totalUsd += pmt.amountUsd ?? 0;
        existing.totalZig += pmt.amountZig ?? 0;
        paymentMap.set(zimraMethod, existing);
      }
    }

    // ── Last receipt hash (chain to last accepted receipt) ─────────────────
    const lastSale = acceptedSales[acceptedSales.length - 1];
    const lastReceiptHash = lastSale?.fiscalHash ?? "";
    const lastReceiptGlobalNo = device.lastReceiptGlobalNo;

    return {
      deviceId: device.deviceId,
      fiscalDayNo: fiscalDay.fiscalDayNo,
      fiscalDayDate: toDateString(fiscalDay.fiscalDayDate),
      openedAt: fiscalDay.openedAt?.toISOString() ?? new Date().toISOString(),
      closedAt: new Date().toISOString(),
      totalReceipts: acceptedSales.length,
      totalSalesUsd: round2(totalSalesUsd),
      totalSalesZig: round2(totalSalesZig),
      totalVatUsd: round2(totalVatUsd),
      totalVatZig: round2(totalVatZig),
      totalDiscountsUsd: round2(totalDiscountsUsd),
      totalRefundsUsd: round2(totalRefundsUsd),
      taxBreakdown: Array.from(taxMap.entries()).map(([cat, vals]) => ({
        taxCategory: cat,
        salesWithTaxUsd: round2(vals.salesWithTaxUsd),
        taxAmountUsd: round2(vals.taxAmountUsd),
        salesWithTaxZig: round2(vals.salesWithTaxZig),
        taxAmountZig: round2(vals.taxAmountZig),
      })),
      paymentBreakdown: Array.from(paymentMap.entries()).map(([method, vals]) => ({
        method,
        totalUsd: round2(vals.totalUsd),
        totalZig: round2(vals.totalZig),
      })),
      lastReceiptGlobalNo,
      lastReceiptHash,
    };
  }

  // ---------------------------------------------------------------------------
  // §7. OFFLINE QUEUE HELPER
  // ---------------------------------------------------------------------------

  private async queueOperation(params: {
    tenantId: string;
    deviceDbId: string;
    operationType: "OPEN_DAY" | "SUBMIT_RECEIPT" | "CLOSE_DAY";
    entityType: string;
    entityId: string;
    idempotencyKey: string;
    payload: object;
  }): Promise<void> {
    const priorityMap: Record<string, number> = {
      OPEN_DAY: 1,
      SUBMIT_RECEIPT: 2,
      CLOSE_DAY: 3,
    };

    await this.prisma.offlineSyncQueue.upsert({
      where: { idempotencyKey: params.idempotencyKey },
      update: {
        status: "PENDING",
        attemptCount: 0,
        nextRetryAt: new Date(),
      },
      create: {
        tenantId: params.tenantId,
        deviceId: params.deviceDbId,
        operationType: params.operationType,
        entityType: params.entityType,
        entityId: params.entityId,
        idempotencyKey: params.idempotencyKey,
        requestPayload: params.payload,
        priority: priorityMap[params.operationType] ?? 5,
        nextRetryAt: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // §8. PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  private async getReferenceReceiptCounter(saleId: string): Promise<number> {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { receiptCounter: true },
    });
    return sale?.receiptCounter ?? 0;
  }

  private async getSaleDate(saleId: string): Promise<Date> {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      select: { createdAt: true },
    });
    return sale?.createdAt ?? new Date();
  }
}

// ---------------------------------------------------------------------------
// §9. PURE HELPER FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Determines receipt currency: if all payments are ZiG-denominated, use ZIG.
 * Otherwise, use USD (the canonical currency for ZIMRA submissions).
 */
function determineReceiptCurrency(
  payments: Array<{ method: string; amountUsd: number; amountZig: number }>
): ZimraCurrencyCode {
  if (payments.length === 0) return "USD";
  const hasUsdPayment = payments.some(
    (p) => p.method.includes("USD") || p.amountUsd > 0
  );
  return hasUsdPayment ? "USD" : "ZIG";
}

/**
 * Maps our internal PaymentMethod enum values to ZIMRA payment type codes.
 * ZIMRA groups all mobile money providers under "MobileWallet".
 */
function mapPaymentMethod(internalMethod: string): ZimraPaymentType {
  if (internalMethod.startsWith("CASH")) return "Cash";
  if (internalMethod.startsWith("ECOCASH") || internalMethod.startsWith("INNBUCKS"))
    return "MobileWallet";
  if (internalMethod.startsWith("SWIPE")) return "Swipe";
  if (internalMethod.startsWith("RTGS") || internalMethod.startsWith("BANK_TRANSFER"))
    return "BankTransfer";
  if (internalMethod === "CREDIT") return "Credit";
  return "Other";
}

/**
 * Maps our internal ReceiptType to ZIMRA receipt type string.
 */
function mapReceiptType(
  internalType: string
): "FiscalInvoice" | "CreditNote" | "DebitNote" {
  switch (internalType) {
    case "FISCAL_CREDIT_NOTE":
      return "CreditNote";
    case "FISCAL_DEBIT_NOTE":
      return "DebitNote";
    default:
      return "FiscalInvoice";
  }
}

/**
 * Aggregates per-line VAT data into ZIMRA receipt-level tax summary entries.
 */
function aggregateTaxesByCategory(
  items: Array<{
    taxCategory: ZimraTaxCategory;
    lineTotalUsd: number;
    vatAmountUsd: number;
    taxableAmountUsd: number;
  }>
): ZimraReceiptTax[] {
  const map = new Map<
    ZimraTaxCategory,
    { salesAmountWithTax: number; taxAmount: number }
  >();

  for (const item of items) {
    const existing = map.get(item.taxCategory) ?? {
      salesAmountWithTax: 0,
      taxAmount: 0,
    };
    existing.salesAmountWithTax += item.lineTotalUsd;
    existing.taxAmount += item.vatAmountUsd;
    map.set(item.taxCategory, existing);
  }

  return Array.from(map.entries()).map(([taxCategory, vals]) => ({
    taxCategory,
    salesAmountWithTax: round2(vals.salesAmountWithTax),
    taxAmount: round2(vals.taxAmount),
  }));
}

/**
 * Converts internal payment list to ZIMRA payment tender entries.
 * Aggregates by ZIMRA payment type code.
 */
function buildZimraPayments(
  payments: Array<{ method: string; amountUsd: number; amountZig: number }>,
  currency: ZimraCurrencyCode
): ZimraReceiptPayment[] {
  const map = new Map<ZimraPaymentType, number>();

  for (const pmt of payments) {
    const zimraType = mapPaymentMethod(pmt.method) as ZimraPaymentType;
    const amount =
      currency === "ZIG" ? (pmt.amountZig ?? 0) : (pmt.amountUsd ?? 0);
    map.set(zimraType, (map.get(zimraType) ?? 0) + amount);
  }

  return Array.from(map.entries()).map(([moneyTypeCode, paymentAmount]) => ({
    moneyTypeCode,
    paymentAmount: round2(paymentAmount),
  }));
}

/**
 * Builds the ZIMRA public receipt verification URL.
 * Format: https://www.zimra.co.zw/verify?code={code}&device={deviceId}
 */
function buildVerifyUrl(verificationCode: string, deviceId: string): string {
  const params = new URLSearchParams({
    code: verificationCode,
    device: deviceId,
  });
  return `https://www.zimra.co.zw/verify?${params.toString()}`;
}

/** Returns today's date at midnight UTC as a Date object. */
function getTodayDate(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/** Formats a Date to "YYYY-MM-DD" string. */
function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

/** Rounds a number to 2 decimal places (standard monetary rounding). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Asserts a device is in ACTIVE status. */
function assertDeviceActive(device: { deviceId: string; status: string }): void {
  if (device.status !== "ACTIVE") {
    throw new DeviceNotActiveError(
      `Device "${device.deviceId}" is not active (status: ${device.status}). ` +
        `Activate the device before processing fiscal transactions.`
    );
  }
}

// ---------------------------------------------------------------------------
// §10. CUSTOM ERROR CLASSES
// ---------------------------------------------------------------------------

export class FiscalDayAlreadyOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiscalDayAlreadyOpenError";
  }
}

export class FiscalDayNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiscalDayNotOpenError";
  }
}

export class MissingCurrencyRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCurrencyRateError";
  }
}

export class PendingSalesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingSalesError";
  }
}

export class DeviceNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotActiveError";
  }
}