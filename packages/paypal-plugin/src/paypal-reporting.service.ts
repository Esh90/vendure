import { Injectable } from '@nestjs/common';
import { ApiError, SearchError } from '@paypal/paypal-server-sdk';
import { InternalServerError, Logger, RequestContext } from '@vendure/core';

import { getTransactionSearchController } from './paypal-client';

const loggerCtx = 'PaypalReportingService';

// ─── Public DTO types (also used by the GQL resolver) ───────────────────────

export interface PaypalMoneyAmount {
    currencyCode: string;
    value: string;
}

export interface PaypalTransactionInfo {
    transactionId?: string;
    transactionStatus?: string;
    transactionEventCode?: string;
    transactionInitiationDate?: string;
    transactionUpdatedDate?: string;
    transactionAmount?: PaypalMoneyAmount;
    feeAmount?: PaypalMoneyAmount;
    invoiceId?: string;
    customField?: string;
}

export interface PaypalPayerInfo {
    emailAddress?: string;
    payerName?: string;
}

export interface PaypalTransactionItem {
    transactionInfo?: PaypalTransactionInfo;
    payerInfo?: PaypalPayerInfo;
}

export interface PaypalTransactionReport {
    transactions: PaypalTransactionItem[];
    totalItems?: number;
    totalPages?: number;
    page?: number;
}

export interface PaypalTransactionSearchInput {
    /** RFC3339 start date-time, e.g. "2024-01-01T00:00:00Z". Required. */
    startDate: string;
    /** RFC3339 end date-time (max 31-day range from startDate). Required. */
    endDate: string;
    /**
     * Optional status filter.
     * D = denied, P = pending, S = success, V = reversed/voided.
     */
    transactionStatus?: string;
    /** Optional ISO-4217 currency code filter, e.g. "USD". */
    transactionCurrency?: string;
    /** Page number (1-based). Defaults to 1. */
    page?: number;
    /** Number of records per page (max 500). Defaults to 100. */
    pageSize?: number;
}

// ─── Error helper ────────────────────────────────────────────────────────────

function extractErrorMessage(err: unknown): string {
    if (err instanceof SearchError) {
        return `PayPal Search error (${err.statusCode}): ${JSON.stringify(err.result)}`;
    }
    if (err instanceof ApiError) {
        return `PayPal API error (${err.statusCode}): ${String(err.body)}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class PaypalReportingService {
    /**
     * UC7 – Search PayPal transactions for a date range.
     *
     * Returns one page of results. Use `input.page` to paginate — check
     * `result.totalPages` to know how many pages exist.
     *
     * Notes from PayPal:
     * - Transactions take up to 3 hours to appear after execution.
     * - Maximum supported date range per call is 31 days.
     * - History goes back 3 years.
     *
     * @param _ctx  - Request context (unused; reserved for future auth checks).
     * @param input - Search parameters.
     */
    async searchTransactions(
        _ctx: RequestContext,
        input: PaypalTransactionSearchInput,
    ): Promise<PaypalTransactionReport> {
        const {
            startDate,
            endDate,
            transactionStatus,
            transactionCurrency,
            page = 1,
            pageSize = 100,
        } = input;

        Logger.info(
            `Searching PayPal transactions from ${startDate} to ${endDate} ` +
                `(page ${page}, size ${pageSize}${transactionStatus ? `, status=${transactionStatus}` : ''})`,
            loggerCtx,
        );

        try {
            const response = await getTransactionSearchController().searchTransactions({
                startDate,
                endDate,
                fields: 'transaction_info,payer_info',
                balanceAffectingRecordsOnly: 'Y',
                pageSize,
                page,
                ...(transactionStatus ? { transactionStatus } : {}),
                ...(transactionCurrency ? { transactionCurrency } : {}),
            });

            if (!response.result) {
                Logger.warn(
                    `PayPal searchTransactions returned an empty result for range ${startDate}–${endDate}.`,
                    loggerCtx,
                );
                return { transactions: [] };
            }

            const searchResult = response.result;

            const transactions: PaypalTransactionItem[] = (
                searchResult.transactionDetails ?? []
            ).map(tx => {
                const item: PaypalTransactionItem = {};

                if (tx.transactionInfo) {
                    const info = tx.transactionInfo;
                    item.transactionInfo = {
                        transactionId: info.transactionId,
                        transactionStatus: info.transactionStatus,
                        transactionEventCode: info.transactionEventCode,
                        transactionInitiationDate: info.transactionInitiationDate,
                        transactionUpdatedDate: info.transactionUpdatedDate,
                        invoiceId: info.invoiceId,
                        customField: info.customField,
                        transactionAmount: info.transactionAmount
                            ? {
                                  currencyCode: info.transactionAmount.currencyCode,
                                  value: info.transactionAmount.value,
                              }
                            : undefined,
                        feeAmount: info.feeAmount
                            ? {
                                  currencyCode: info.feeAmount.currencyCode,
                                  value: info.feeAmount.value,
                              }
                            : undefined,
                    };
                }

                if (tx.payerInfo) {
                    item.payerInfo = {
                        emailAddress: tx.payerInfo.emailAddress,
                        payerName: tx.payerInfo.payerName?.fullName,
                    };
                }

                return item;
            });

            Logger.info(
                `PayPal transaction search returned ${transactions.length} transaction(s) ` +
                    `(page ${searchResult.page ?? page} of ${searchResult.totalPages ?? '?'}, ` +
                    `total ${searchResult.totalItems ?? '?'}).`,
                loggerCtx,
            );

            return {
                transactions,
                totalItems: searchResult.totalItems,
                totalPages: searchResult.totalPages,
                page: searchResult.page,
            };
        } catch (err: unknown) {
            const message = extractErrorMessage(err);
            Logger.error(
                `Failed to search PayPal transactions (${startDate}–${endDate}): ${message}`,
                loggerCtx,
            );
            throw new InternalServerError(message);
        }
    }
}
