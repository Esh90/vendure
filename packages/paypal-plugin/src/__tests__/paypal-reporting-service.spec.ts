import { InternalServerError } from '@vendure/core';

// ---------------------------------------------------------------------------
// Mock paypal-client before the service module is loaded
// ---------------------------------------------------------------------------
const mockSearchTransactions = jest.fn();

const mockTransactionSearchController = {
    searchTransactions: mockSearchTransactions,
};

jest.mock('../paypal-client', () => ({
    getTransactionSearchController: jest.fn(() => mockTransactionSearchController),
    _resetPaypalClientForTesting: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Stub @vendure/core Logger
// ---------------------------------------------------------------------------
jest.mock('@vendure/core', () => ({
    ...jest.requireActual('@vendure/core'),
    Logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    },
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered
// ---------------------------------------------------------------------------
import { PaypalReportingService } from '../paypal-reporting.service';
import { _resetPaypalClientForTesting } from '../paypal-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ctx = {} as any;

function makeSearchResponse(
    transactions: Array<{
        transactionId: string;
        amount?: string;
        currency?: string;
        status?: string;
        email?: string;
    }> = [],
    overrides: Record<string, unknown> = {},
) {
    return {
        result: {
            transactionDetails: transactions.map(t => ({
                transactionInfo: {
                    transactionId: t.transactionId,
                    transactionStatus: t.status ?? 'S',
                    transactionEventCode: 'T0006',
                    transactionInitiationDate: '2024-01-15T10:00:00Z',
                    transactionUpdatedDate: '2024-01-15T10:01:00Z',
                    transactionAmount: {
                        currencyCode: t.currency ?? 'USD',
                        value: t.amount ?? '19.99',
                    },
                    feeAmount: { currencyCode: t.currency ?? 'USD', value: '0.88' },
                    invoiceId: `INV-${t.transactionId}`,
                },
                payerInfo: {
                    emailAddress: t.email ?? 'buyer@example.com',
                    payerName: { fullName: 'Test Buyer' },
                },
            })),
            totalItems: transactions.length,
            totalPages: 1,
            page: 1,
            startDate: '2024-01-01T00:00:00Z',
            endDate: '2024-01-31T23:59:59Z',
            ...overrides,
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PaypalReportingService', () => {
    let service: PaypalReportingService;

    beforeEach(() => {
        jest.clearAllMocks();
        _resetPaypalClientForTesting();
        service = new PaypalReportingService();
    });

    const BASE_INPUT = {
        startDate: '2024-01-01T00:00:00Z',
        endDate: '2024-01-31T23:59:59Z',
    };

    // ─── searchTransactions ─────────────────────────────────────────────────────

    describe('searchTransactions', () => {
        it('returns mapped transactions on success', async () => {
            mockSearchTransactions.mockResolvedValueOnce(
                makeSearchResponse([{ transactionId: 'TX-001', amount: '29.99' }]),
            );

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions).toHaveLength(1);
            const tx = result.transactions[0];
            expect(tx.transactionInfo?.transactionId).toBe('TX-001');
            expect(tx.transactionInfo?.transactionAmount?.value).toBe('29.99');
            expect(tx.transactionInfo?.transactionAmount?.currencyCode).toBe('USD');
            expect(tx.payerInfo?.emailAddress).toBe('buyer@example.com');
            expect(tx.payerInfo?.payerName).toBe('Test Buyer');
        });

        it('returns pagination metadata', async () => {
            mockSearchTransactions.mockResolvedValueOnce(
                makeSearchResponse([{ transactionId: 'TX-001' }], {
                    totalItems: 250,
                    totalPages: 3,
                    page: 1,
                }),
            );

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.totalItems).toBe(250);
            expect(result.totalPages).toBe(3);
            expect(result.page).toBe(1);
        });

        it('maps feeAmount and invoiceId correctly', async () => {
            mockSearchTransactions.mockResolvedValueOnce(
                makeSearchResponse([{ transactionId: 'TX-002' }]),
            );

            const result = await service.searchTransactions(ctx, BASE_INPUT);
            const info = result.transactions[0].transactionInfo;

            expect(info?.feeAmount?.value).toBe('0.88');
            expect(info?.invoiceId).toBe('INV-TX-002');
        });

        it('sends startDate, endDate, fields, and balanceAffectingRecordsOnly to the SDK', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, BASE_INPUT);

            expect(mockSearchTransactions).toHaveBeenCalledWith(
                expect.objectContaining({
                    startDate: BASE_INPUT.startDate,
                    endDate: BASE_INPUT.endDate,
                    fields: 'transaction_info,payer_info',
                    balanceAffectingRecordsOnly: 'Y',
                }),
            );
        });

        it('passes transactionStatus filter when provided', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, { ...BASE_INPUT, transactionStatus: 'S' });

            expect(mockSearchTransactions).toHaveBeenCalledWith(
                expect.objectContaining({ transactionStatus: 'S' }),
            );
        });

        it('omits transactionStatus from request when not provided', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, BASE_INPUT);

            const callArg = mockSearchTransactions.mock.calls[0][0];
            expect(callArg).not.toHaveProperty('transactionStatus');
        });

        it('passes transactionCurrency filter when provided', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, { ...BASE_INPUT, transactionCurrency: 'EUR' });

            expect(mockSearchTransactions).toHaveBeenCalledWith(
                expect.objectContaining({ transactionCurrency: 'EUR' }),
            );
        });

        it('omits transactionCurrency from request when not provided', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, BASE_INPUT);

            const callArg = mockSearchTransactions.mock.calls[0][0];
            expect(callArg).not.toHaveProperty('transactionCurrency');
        });

        it('uses page=1 and pageSize=100 as defaults', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, BASE_INPUT);

            expect(mockSearchTransactions).toHaveBeenCalledWith(
                expect.objectContaining({ page: 1, pageSize: 100 }),
            );
        });

        it('passes custom page and pageSize when provided', async () => {
            mockSearchTransactions.mockResolvedValueOnce(makeSearchResponse([]));

            await service.searchTransactions(ctx, { ...BASE_INPUT, page: 3, pageSize: 50 });

            expect(mockSearchTransactions).toHaveBeenCalledWith(
                expect.objectContaining({ page: 3, pageSize: 50 }),
            );
        });

        it('returns empty transactions array when result is null', async () => {
            mockSearchTransactions.mockResolvedValueOnce({ result: null });

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions).toEqual([]);
            expect(result.totalItems).toBeUndefined();
        });

        it('handles response with no transactionDetails gracefully', async () => {
            mockSearchTransactions.mockResolvedValueOnce({
                result: { transactionDetails: undefined, totalItems: 0, totalPages: 0, page: 1 },
            });

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions).toEqual([]);
            expect(result.totalItems).toBe(0);
        });

        it('handles transaction with no payerInfo', async () => {
            mockSearchTransactions.mockResolvedValueOnce({
                result: {
                    transactionDetails: [{
                        transactionInfo: {
                            transactionId: 'TX-NOPAYER',
                            transactionStatus: 'S',
                            transactionAmount: { currencyCode: 'USD', value: '10.00' },
                        },
                        payerInfo: undefined,
                    }],
                    totalItems: 1,
                    totalPages: 1,
                    page: 1,
                },
            });

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions[0].payerInfo).toBeUndefined();
            expect(result.transactions[0].transactionInfo?.transactionId).toBe('TX-NOPAYER');
        });

        it('handles transaction with no transactionInfo', async () => {
            mockSearchTransactions.mockResolvedValueOnce({
                result: {
                    transactionDetails: [{ transactionInfo: undefined, payerInfo: undefined }],
                    totalItems: 1,
                    totalPages: 1,
                    page: 1,
                },
            });

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions[0].transactionInfo).toBeUndefined();
        });

        it('returns multiple transactions', async () => {
            mockSearchTransactions.mockResolvedValueOnce(
                makeSearchResponse([
                    { transactionId: 'TX-A', amount: '10.00' },
                    { transactionId: 'TX-B', amount: '20.00' },
                    { transactionId: 'TX-C', amount: '30.00' },
                ], { totalItems: 3, totalPages: 1 }),
            );

            const result = await service.searchTransactions(ctx, BASE_INPUT);

            expect(result.transactions).toHaveLength(3);
            expect(result.transactions.map(t => t.transactionInfo?.transactionId)).toEqual([
                'TX-A', 'TX-B', 'TX-C',
            ]);
        });

        it('throws InternalServerError when SDK throws ApiError', async () => {
            const apiError = Object.assign(new Error('Unauthorized'), {
                statusCode: 401, headers: {}, body: 'Unauthorized',
            });
            mockSearchTransactions.mockRejectedValueOnce(apiError);

            await expect(
                service.searchTransactions(ctx, BASE_INPUT),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('wraps error message in InternalServerError', async () => {
            mockSearchTransactions.mockRejectedValueOnce(new Error('Network timeout'));

            const err = await service.searchTransactions(ctx, BASE_INPUT).catch(e => e);

            expect(err).toBeInstanceOf(InternalServerError);
            expect(err.message).toContain('Network timeout');
        });

        it('handles SearchError specifically', async () => {
            const searchError = Object.assign(new Error('Result set too large'), {
                statusCode: 403,
                headers: {},
                body: 'RESULTSET_TOO_LARGE',
                result: { name: 'RESULTSET_TOO_LARGE', message: 'Result set too large' },
            });
            mockSearchTransactions.mockRejectedValueOnce(searchError);

            const err = await service.searchTransactions(ctx, BASE_INPUT).catch(e => e);

            expect(err).toBeInstanceOf(InternalServerError);
        });
    });
});
