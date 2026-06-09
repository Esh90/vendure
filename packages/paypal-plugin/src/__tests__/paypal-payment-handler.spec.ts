import { ApiError, CheckoutPaymentIntent, PaypalExperienceUserAction } from '@paypal/paypal-server-sdk';

// Mock the paypal-client module so no real SDK calls are made.
const mockCaptureOrder = jest.fn();
const mockCreateOrder = jest.fn();
const mockOrdersController = {
    createOrder: mockCreateOrder,
    captureOrder: mockCaptureOrder,
};

jest.mock('../paypal-client', () => ({
    getOrdersController: jest.fn(() => mockOrdersController),
    _resetPaypalClientForTesting: jest.fn(),
}));

// Suppress logger output during tests.
jest.mock('@vendure/core', () => ({
    ...jest.requireActual('@vendure/core'),
    Logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { paypalPaymentHandler } from '../paypal-payment-handler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RETURN_URL = 'https://my-store.com/checkout/paypal-return';
const CANCEL_URL = 'https://my-store.com/checkout/paypal-cancel';

function makeCtx() { return {} as any; }

function makeOrder(overrides: Record<string, unknown> = {}) {
    return { id: '42', currencyCode: 'USD', ...overrides } as any;
}

function makePayment(overrides: Record<string, unknown> = {}) {
    return {
        id: '99',
        transactionId: 'PAYPAL-ORDER-001',
        state: 'Authorized',
        metadata: {},
        ...overrides,
    } as any;
}

function makeCreateOrderResponse(
    paypalOrderId: string,
    approvalUrl: string,
    linkRel: 'payer-action' | 'approve' = 'payer-action',
) {
    return {
        statusCode: 201,
        result: {
            id: paypalOrderId,
            intent: CheckoutPaymentIntent.Capture,
            // When paymentSource.paypal is used PayPal returns PAYER_ACTION_REQUIRED
            // and uses rel='payer-action'; the classic flow uses CREATED / 'approve'.
            status: linkRel === 'payer-action' ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
            links: [
                { rel: 'self', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${paypalOrderId}` },
                { rel: linkRel, href: approvalUrl },
                { rel: 'capture', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${paypalOrderId}/capture` },
            ],
        },
        headers: {},
        body: '{}',
    };
}

function makeCaptureOrderResponse(captureId: string, captureStatus = 'COMPLETED') {
    return {
        statusCode: 201,
        result: {
            id: 'PAYPAL-ORDER-001',
            status: 'COMPLETED',
            purchaseUnits: [{
                payments: {
                    captures: [{
                        id: captureId,
                        status: captureStatus,
                        amount: { currencyCode: 'USD', value: '19.99' },
                    }],
                },
            }],
        },
        headers: {},
        body: '{}',
    };
}

// ─── createPayment ────────────────────────────────────────────────────────────

describe('paypalPaymentHandler.createPayment', () => {
    const createPaymentFn = (paypalPaymentHandler as any).createPayment;

    beforeEach(() => jest.clearAllMocks());

    it('returns Authorized state with approvalUrl on success', async () => {
        const paypalOrderId = 'PAYPAL-ORDER-001';
        const approvalUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`;
        mockCreateOrder.mockResolvedValueOnce(makeCreateOrderResponse(paypalOrderId, approvalUrl));

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Authorized');
        expect(result.amount).toBe(1999);
        expect(result.transactionId).toBe(paypalOrderId);
        expect(result.metadata?.paypalOrderId).toBe(paypalOrderId);
        expect(result.metadata?.public?.approvalUrl).toBe(approvalUrl);
    });

    it('sends returnUrl, cancelUrl, and PAY_NOW userAction in experienceContext', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-XYZ', 'https://paypal.com/approve'),
        );

        await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    intent: CheckoutPaymentIntent.Capture,
                    paymentSource: {
                        paypal: {
                            experienceContext: {
                                returnUrl: RETURN_URL,
                                cancelUrl: CANCEL_URL,
                                userAction: PaypalExperienceUserAction.PayNow,
                            },
                        },
                    },
                }),
            }),
        );
    });

    it('returns Declined with descriptive message when returnUrl is missing', async () => {
        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { cancelUrl: CANCEL_URL },   // returnUrl intentionally omitted
        );

        expect(result.state).toBe('Declined');
        expect(result.errorMessage).toMatch(/returnUrl/);
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('returns Declined with descriptive message when cancelUrl is missing', async () => {
        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL },   // cancelUrl intentionally omitted
        );

        expect(result.state).toBe('Declined');
        expect(result.errorMessage).toMatch(/cancelUrl/);
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('returns Declined when both URLs are missing', async () => {
        const result = await createPaymentFn(makeCtx(), makeOrder(), 1999, {}, {});

        expect(result.state).toBe('Declined');
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it('passes CAPTURE intent and correct currency/amount', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-EUR', 'https://paypal.com/approve'),
        );

        await createPaymentFn(
            makeCtx(), makeOrder({ currencyCode: 'EUR' }), 5000, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    purchaseUnits: expect.arrayContaining([
                        expect.objectContaining({
                            amount: { currencyCode: 'EUR', value: '50.00' },
                        }),
                    ]),
                }),
            }),
        );
    });

    it('returns Declined when PayPal createOrder throws ApiError', async () => {
        const apiError = Object.assign(new Error('Unauthorized'), {
            statusCode: 401, headers: {}, body: 'Unauthorized',
        });
        Object.setPrototypeOf(apiError, ApiError.prototype);
        mockCreateOrder.mockRejectedValueOnce(apiError);

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Declined');
        expect(result.errorMessage).toBeDefined();
    });

    it('extracts approvalUrl from payer-action link (Advanced Checkout / paymentSource.paypal flow)', async () => {
        const paypalOrderId = 'PAYPAL-ORDER-ADV';
        const approvalUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`;
        // Default makeCreateOrderResponse uses 'payer-action'
        mockCreateOrder.mockResolvedValueOnce(makeCreateOrderResponse(paypalOrderId, approvalUrl, 'payer-action'));

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Authorized');
        expect(result.metadata?.public?.approvalUrl).toBe(approvalUrl);
        expect(result.metadata?.public?.approvalUrl).not.toBe('');
    });

    it('falls back to approve link when payer-action is not present (classic flow)', async () => {
        const paypalOrderId = 'PAYPAL-ORDER-CLASSIC';
        const approvalUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`;
        mockCreateOrder.mockResolvedValueOnce(makeCreateOrderResponse(paypalOrderId, approvalUrl, 'approve'));

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Authorized');
        expect(result.metadata?.public?.approvalUrl).toBe(approvalUrl);
    });

    it('returns Declined when neither payer-action nor approve link is present in response', async () => {
        mockCreateOrder.mockResolvedValueOnce({
            statusCode: 201,
            result: {
                id: 'PAYPAL-ORDER-NO-LINK',
                status: 'CREATED',
                links: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v2/checkout/orders/PAYPAL-ORDER-NO-LINK' }],
            },
            headers: {},
            body: '{}',
        });

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Declined');
        expect(result.errorMessage).toMatch(/missing the buyer-approval link/i);
    });

    it('returns Declined when createOrder returns empty result', async () => {
        mockCreateOrder.mockResolvedValueOnce({ statusCode: 201, result: null, headers: {}, body: '{}' });

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Declined');
    });

    it('converts zero-decimal currency (JPY) without dividing by 100', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-JPY', 'https://paypal.com/approve'),
        );

        await createPaymentFn(
            makeCtx(), makeOrder({ currencyCode: 'JPY' }), 1500, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    purchaseUnits: expect.arrayContaining([
                        expect.objectContaining({
                            amount: { currencyCode: 'JPY', value: '1500' },
                        }),
                    ]),
                }),
            }),
        );
    });
});

// ─── settlePayment ────────────────────────────────────────────────────────────

describe('paypalPaymentHandler.settlePayment', () => {
    const settlePaymentFn = (paypalPaymentHandler as any).settlePayment;

    beforeEach(() => jest.clearAllMocks());

    it('returns success with captureId and captureStatus on successful capture', async () => {
        const captureId = 'CAPTURE-ABC-123';
        mockCaptureOrder.mockResolvedValueOnce(makeCaptureOrderResponse(captureId, 'COMPLETED'));

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ transactionId: 'PAYPAL-ORDER-001' }),
            {},
        );

        expect(result.success).toBe(true);
        expect(result.metadata?.captureId).toBe(captureId);
        expect(result.metadata?.captureStatus).toBe('COMPLETED');
    });

    it('calls captureOrder with the payment transactionId', async () => {
        mockCaptureOrder.mockResolvedValueOnce(makeCaptureOrderResponse('CAP-001'));

        await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ transactionId: 'PAYPAL-ORDER-999' }),
            {},
        );

        expect(mockCaptureOrder).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'PAYPAL-ORDER-999' }),
        );
    });

    it('returns failure when transactionId is missing on the payment', async () => {
        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ transactionId: undefined }),
            {},
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/no paypal order id/i);
        expect(mockCaptureOrder).not.toHaveBeenCalled();
    });

    it('returns failure when captureOrder throws ApiError', async () => {
        const apiError = Object.assign(new Error('Unprocessable'), {
            statusCode: 422, headers: {}, body: 'ORDER_ALREADY_CAPTURED',
        });
        Object.setPrototypeOf(apiError, ApiError.prototype);
        mockCaptureOrder.mockRejectedValueOnce(apiError);

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ transactionId: 'PAYPAL-ORDER-001' }),
            {},
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBeDefined();
    });

    it('returns failure when captureOrder returns empty result', async () => {
        mockCaptureOrder.mockResolvedValueOnce({ statusCode: 201, result: null, headers: {}, body: '{}' });

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ transactionId: 'PAYPAL-ORDER-001' }),
            {},
        );

        expect(result.success).toBe(false);
    });
});
