import { ApiError, CheckoutPaymentIntent, PaypalExperienceUserAction } from '@paypal/paypal-server-sdk';

// Mock the paypal-client module so no real SDK calls are made.
const mockCaptureOrder = jest.fn();
const mockCreateOrder = jest.fn();
const mockAuthorizeOrder = jest.fn();
const mockOrdersController = {
    createOrder: mockCreateOrder,
    captureOrder: mockCaptureOrder,
    authorizeOrder: mockAuthorizeOrder,
};

const mockCaptureAuthorizedPayment = jest.fn();
const mockVoidPayment = jest.fn();
const mockPaymentsController = {
    captureAuthorizedPayment: mockCaptureAuthorizedPayment,
    voidPayment: mockVoidPayment,
};

jest.mock('../paypal-client', () => ({
    getOrdersController: jest.fn(() => mockOrdersController),
    getPaymentsController: jest.fn(() => mockPaymentsController),
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

/** UC2: captureAuthorizedPayment returns a CapturedPayment directly (not wrapped in purchaseUnits). */
function makeCaptureAuthorizedPaymentResponse(captureId: string, captureStatus = 'COMPLETED') {
    return {
        statusCode: 201,
        result: {
            id: captureId,
            status: captureStatus,
        },
        headers: {},
        body: '{}',
    };
}

/** UC2: authorizeOrder response with authorizationId nested in purchaseUnits. */
function makeAuthorizeOrderResponse(authorizationId: string, authorizationStatus = 'CREATED') {
    return {
        statusCode: 201,
        result: {
            id: 'PAYPAL-ORDER-001',
            status: 'COMPLETED',
            purchaseUnits: [{
                payments: {
                    authorizations: [{
                        id: authorizationId,
                        status: authorizationStatus,
                    }],
                },
            }],
        },
        headers: {},
        body: '{}',
    };
}

// ─── createPayment (UC1 – CAPTURE intent) ────────────────────────────────────

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

// ─── createPayment (UC2 – AUTHORIZE intent) ───────────────────────────────────

describe('paypalPaymentHandler.createPayment (AUTHORIZE intent)', () => {
    const createPaymentFn = (paypalPaymentHandler as any).createPayment;

    beforeEach(() => jest.clearAllMocks());

    it('sends AUTHORIZE intent when metadata.intent === "authorize"', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-AUTH-001', 'https://paypal.com/approve'),
        );

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { intent: 'authorize', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Authorized');
        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    intent: CheckoutPaymentIntent.Authorize,
                }),
            }),
        );
    });

    it('returns approvalUrl in metadata when AUTHORIZE intent succeeds', async () => {
        const paypalOrderId = 'ORDER-AUTH-002';
        const approvalUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`;
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse(paypalOrderId, approvalUrl),
        );

        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 5000, {},
            { intent: 'authorize', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Authorized');
        expect(result.transactionId).toBe(paypalOrderId);
        expect(result.metadata?.public?.approvalUrl).toBe(approvalUrl);
    });

    it('uses CAPTURE intent when metadata.intent is absent', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-CAP', 'https://paypal.com/approve'),
        );

        await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { returnUrl: RETURN_URL, cancelUrl: CANCEL_URL }, // no intent field
        );

        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    intent: CheckoutPaymentIntent.Capture,
                }),
            }),
        );
    });

    it('uses CAPTURE intent when metadata.intent is an unrecognized value', async () => {
        mockCreateOrder.mockResolvedValueOnce(
            makeCreateOrderResponse('ORDER-CAP2', 'https://paypal.com/approve'),
        );

        await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { intent: 'unknown-value', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL },
        );

        expect(mockCreateOrder).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    intent: CheckoutPaymentIntent.Capture,
                }),
            }),
        );
    });

    it('returns Declined when returnUrl is missing even for AUTHORIZE intent', async () => {
        const result = await createPaymentFn(
            makeCtx(), makeOrder(), 1999, {},
            { intent: 'authorize', cancelUrl: CANCEL_URL },
        );

        expect(result.state).toBe('Declined');
        expect(mockCreateOrder).not.toHaveBeenCalled();
    });
});

// ─── settlePayment (UC1 – direct captureOrder) ────────────────────────────────

describe('paypalPaymentHandler.settlePayment (UC1 – direct capture)', () => {
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

// ─── settlePayment (UC2 – captureAuthorizedPayment) ──────────────────────────

describe('paypalPaymentHandler.settlePayment (UC2 – authorized capture)', () => {
    const settlePaymentFn = (paypalPaymentHandler as any).settlePayment;

    beforeEach(() => jest.clearAllMocks());

    it('calls captureAuthorizedPayment when authorizationId is present in metadata', async () => {
        const authorizationId = 'AUTH-001';
        mockCaptureAuthorizedPayment.mockResolvedValueOnce(
            makeCaptureAuthorizedPaymentResponse('CAP-AUTH-001'),
        );

        await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId } }),
            {},
        );

        expect(mockCaptureAuthorizedPayment).toHaveBeenCalledWith(
            expect.objectContaining({ authorizationId: 'AUTH-001' }),
        );
        expect(mockCaptureOrder).not.toHaveBeenCalled();
    });

    it('returns success with captureId and captureStatus from CapturedPayment', async () => {
        const captureId = 'CAP-AUTH-XYZ';
        mockCaptureAuthorizedPayment.mockResolvedValueOnce(
            makeCaptureAuthorizedPaymentResponse(captureId, 'COMPLETED'),
        );

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-001' } }),
            {},
        );

        expect(result.success).toBe(true);
        expect(result.metadata?.captureId).toBe(captureId);
        expect(result.metadata?.captureStatus).toBe('COMPLETED');
    });

    it('sends finalCapture: true in the request body', async () => {
        mockCaptureAuthorizedPayment.mockResolvedValueOnce(
            makeCaptureAuthorizedPaymentResponse('CAP-001'),
        );

        await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-002' } }),
            {},
        );

        expect(mockCaptureAuthorizedPayment).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.objectContaining({ finalCapture: true }) }),
        );
    });

    it('returns failure when captureAuthorizedPayment throws ApiError', async () => {
        const apiError = Object.assign(new Error('Authorization expired'), {
            statusCode: 422, headers: {}, body: 'AUTHORIZATION_ALREADY_CAPTURED',
        });
        Object.setPrototypeOf(apiError, ApiError.prototype);
        mockCaptureAuthorizedPayment.mockRejectedValueOnce(apiError);

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-003' } }),
            {},
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBeDefined();
    });

    it('returns failure when captureAuthorizedPayment returns empty result', async () => {
        mockCaptureAuthorizedPayment.mockResolvedValueOnce(
            { statusCode: 201, result: null, headers: {}, body: '{}' },
        );

        const result = await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-004' } }),
            {},
        );

        expect(result.success).toBe(false);
    });

    it('falls back to UC1 captureOrder when authorizationId is absent from metadata', async () => {
        mockCaptureOrder.mockResolvedValueOnce(makeCaptureOrderResponse('CAP-FALLBACK'));

        await settlePaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: {} }),   // no authorizationId
            {},
        );

        expect(mockCaptureOrder).toHaveBeenCalled();
        expect(mockCaptureAuthorizedPayment).not.toHaveBeenCalled();
    });
});

// ─── cancelPayment (UC3 – void authorization) ────────────────────────────────

describe('paypalPaymentHandler.cancelPayment', () => {
    const cancelPaymentFn = (paypalPaymentHandler as any).cancelPayment;

    beforeEach(() => jest.clearAllMocks());

    it('calls voidPayment with authorizationId when present in metadata', async () => {
        // voidPayment returns 204 No Content → result is null; success = no exception thrown
        mockVoidPayment.mockResolvedValueOnce({ statusCode: 204, result: null, headers: {}, body: '' });

        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-VOID-001' } }),
            {},
        );

        expect(result.success).toBe(true);
        expect(mockVoidPayment).toHaveBeenCalledWith(
            expect.objectContaining({ authorizationId: 'AUTH-VOID-001', prefer: 'return=minimal' }),
        );
    });

    it('returns success without calling voidPayment when no authorizationId in metadata', async () => {
        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: {} }),   // UC1 / pre-authorization — no authorizationId
            {},
        );

        expect(result.success).toBe(true);
        expect(mockVoidPayment).not.toHaveBeenCalled();
    });

    it('returns success without calling voidPayment when metadata is absent', async () => {
        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: null }),
            {},
        );

        expect(result.success).toBe(true);
        expect(mockVoidPayment).not.toHaveBeenCalled();
    });

    it('returns failure when voidPayment throws ApiError', async () => {
        const apiError = Object.assign(new Error('Unprocessable'), {
            statusCode: 422, headers: {}, body: 'AUTHORIZATION_ALREADY_CAPTURED',
        });
        Object.setPrototypeOf(apiError, ApiError.prototype);
        mockVoidPayment.mockRejectedValueOnce(apiError);

        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-VOID-002' } }),
            {},
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/PayPal API error/i);
    });

    it('returns failure when voidPayment throws a generic error', async () => {
        mockVoidPayment.mockRejectedValueOnce(new Error('Network timeout'));

        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-VOID-003' } }),
            {},
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('Network timeout');
    });

    it('treats a non-null 200 result (return=representation) as success', async () => {
        mockVoidPayment.mockResolvedValueOnce({
            statusCode: 200,
            result: { id: 'AUTH-VOID-004', status: 'VOIDED' },
            headers: {},
            body: '{}',
        });

        const result = await cancelPaymentFn(
            makeCtx(), makeOrder(),
            makePayment({ metadata: { authorizationId: 'AUTH-VOID-004' } }),
            {},
        );

        expect(result.success).toBe(true);
    });
});
