import { InternalServerError } from '@vendure/core';

// ---------------------------------------------------------------------------
// Mock paypal-client before the service module is loaded
// ---------------------------------------------------------------------------
const mockCreateOrderTracking = jest.fn();
const mockUpdateOrderTracking = jest.fn();

const mockOrdersController = {
    createOrderTracking: mockCreateOrderTracking,
    updateOrderTracking: mockUpdateOrderTracking,
};

jest.mock('../paypal-client', () => ({
    getOrdersController: jest.fn(() => mockOrdersController),
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
import { PaypalTrackingService } from '../paypal-tracking.service';
import { _resetPaypalClientForTesting } from '../paypal-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ctx = {} as any;

const ORDER_ID = 'PAYPAL-ORDER-001';
const CAPTURE_ID = 'CAP-001';
const TRACKER_ID = `${ORDER_ID}-${CAPTURE_ID}`;
const TRACKING_NUMBER = '1Z999AA10123456784';
const CARRIER = 'UPS';

function makeCreateTrackingResponse(trackerId: string, status = 'SHIPPED') {
    return {
        statusCode: 200,
        result: {
            id: ORDER_ID,
            purchaseUnits: [
                {
                    shipping: {
                        trackers: [
                            {
                                id: trackerId,
                                status,
                                createTime: '2024-01-15T10:00:00Z',
                                updateTime: '2024-01-15T10:00:00Z',
                            },
                        ],
                    },
                },
            ],
        },
        headers: {},
        body: '{}',
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PaypalTrackingService', () => {
    let service: PaypalTrackingService;

    beforeEach(() => {
        jest.clearAllMocks();
        _resetPaypalClientForTesting();
        service = new PaypalTrackingService();
    });

    // ─── addShipmentTracking ─────────────────────────────────────────────────────

    describe('addShipmentTracking', () => {
        const BASE_INPUT = {
            paypalOrderId: ORDER_ID,
            captureId: CAPTURE_ID,
            trackingNumber: TRACKING_NUMBER,
            carrier: CARRIER,
        };

        it('returns trackerId and status on success', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID, 'SHIPPED'),
            );

            const result = await service.addShipmentTracking(ctx, BASE_INPUT);

            expect(result.trackerId).toBe(TRACKER_ID);
            expect(result.status).toBe('SHIPPED');
        });

        it('calls createOrderTracking with correct orderId and captureId', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, BASE_INPUT);

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: ORDER_ID,
                    body: expect.objectContaining({
                        captureId: CAPTURE_ID,
                    }),
                }),
            );
        });

        it('sends trackingNumber and carrier in the request body', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, BASE_INPUT);

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.objectContaining({
                        trackingNumber: TRACKING_NUMBER,
                        carrier: CARRIER,
                    }),
                }),
            );
        });

        it('defaults notifyPayer to false when not provided', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, BASE_INPUT);

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.objectContaining({ notifyPayer: false }),
                }),
            );
        });

        it('passes notifyPayer: true when requested', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, { ...BASE_INPUT, notifyPayer: true });

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.objectContaining({ notifyPayer: true }),
                }),
            );
        });

        it('passes carrierNameOther when carrier is OTHER', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, {
                ...BASE_INPUT,
                carrier: 'OTHER',
                carrierNameOther: 'My Custom Carrier',
            });

            expect(mockCreateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.objectContaining({
                        carrier: 'OTHER',
                        carrierNameOther: 'My Custom Carrier',
                    }),
                }),
            );
        });

        it('omits carrierNameOther when carrier is not OTHER', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce(
                makeCreateTrackingResponse(TRACKER_ID),
            );

            await service.addShipmentTracking(ctx, {
                ...BASE_INPUT,
                carrier: 'UPS',
                carrierNameOther: 'ignored',
            });

            const callBody = mockCreateOrderTracking.mock.calls[0][0].body;
            expect(callBody).not.toHaveProperty('carrierNameOther');
        });

        it('throws InternalServerError when result is null', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce({ result: null });

            await expect(
                service.addShipmentTracking(ctx, BASE_INPUT),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when tracker id is missing from response', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce({
                result: {
                    id: ORDER_ID,
                    purchaseUnits: [{ shipping: { trackers: [{ id: undefined }] } }],
                },
            });

            await expect(
                service.addShipmentTracking(ctx, BASE_INPUT),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when purchaseUnits is empty', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce({
                result: { id: ORDER_ID, purchaseUnits: [] },
            });

            await expect(
                service.addShipmentTracking(ctx, BASE_INPUT),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when trackers array is absent', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce({
                result: {
                    id: ORDER_ID,
                    purchaseUnits: [{ shipping: { trackers: undefined } }],
                },
            });

            await expect(
                service.addShipmentTracking(ctx, BASE_INPUT),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('wraps SDK errors in InternalServerError', async () => {
            const apiError = Object.assign(new Error('Forbidden'), {
                statusCode: 403, headers: {}, body: 'INSUFFICIENT_PERMISSIONS',
            });
            mockCreateOrderTracking.mockRejectedValueOnce(apiError);

            const err = await service.addShipmentTracking(ctx, BASE_INPUT).catch(e => e);

            expect(err).toBeInstanceOf(InternalServerError);
            expect(err.message).toContain('Forbidden');
        });

        it('re-throws InternalServerError without double-wrapping', async () => {
            // A null result causes InternalServerError inside the try block
            mockCreateOrderTracking.mockResolvedValueOnce({ result: null });

            const err = await service.addShipmentTracking(ctx, BASE_INPUT).catch(e => e);

            expect(err).toBeInstanceOf(InternalServerError);
            // Should not be wrapped in another InternalServerError
            expect(err.message).not.toContain('InternalServerError');
        });

        it('uses "SHIPPED" as default status when tracker status is undefined', async () => {
            mockCreateOrderTracking.mockResolvedValueOnce({
                result: {
                    id: ORDER_ID,
                    purchaseUnits: [{ shipping: { trackers: [{ id: TRACKER_ID, status: undefined }] } }],
                },
            });

            const result = await service.addShipmentTracking(ctx, BASE_INPUT);

            expect(result.status).toBe('SHIPPED');
        });
    });

    // ─── cancelShipmentTracking ──────────────────────────────────────────────────

    describe('cancelShipmentTracking', () => {
        it('returns true when PayPal returns 204 (no exception)', async () => {
            mockUpdateOrderTracking.mockResolvedValueOnce(undefined);

            const result = await service.cancelShipmentTracking(ctx, ORDER_ID, TRACKER_ID);

            expect(result).toBe(true);
        });

        it('calls updateOrderTracking with correct orderId and trackerId', async () => {
            mockUpdateOrderTracking.mockResolvedValueOnce(undefined);

            await service.cancelShipmentTracking(ctx, ORDER_ID, TRACKER_ID);

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: ORDER_ID,
                    trackerId: TRACKER_ID,
                }),
            );
        });

        it('sends CANCELLED patch operation in the request body', async () => {
            mockUpdateOrderTracking.mockResolvedValueOnce(undefined);

            await service.cancelShipmentTracking(ctx, ORDER_ID, TRACKER_ID);

            expect(mockUpdateOrderTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.arrayContaining([
                        expect.objectContaining({
                            path: '/status',
                            value: 'CANCELLED',
                        }),
                    ]),
                }),
            );
        });

        it('throws InternalServerError when PayPal rejects', async () => {
            const apiError = Object.assign(new Error('Tracker not found'), {
                statusCode: 404, headers: {}, body: 'RESOURCE_NOT_FOUND',
            });
            mockUpdateOrderTracking.mockRejectedValueOnce(apiError);

            await expect(
                service.cancelShipmentTracking(ctx, ORDER_ID, TRACKER_ID),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('includes error message in InternalServerError', async () => {
            mockUpdateOrderTracking.mockRejectedValueOnce(new Error('Validation failed'));

            const err = await service.cancelShipmentTracking(ctx, ORDER_ID, TRACKER_ID).catch(e => e);

            expect(err).toBeInstanceOf(InternalServerError);
            expect(err.message).toContain('Validation failed');
        });
    });
});
