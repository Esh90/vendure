import { InternalServerError } from '@vendure/core';

// ---------------------------------------------------------------------------
// Mock paypal-client before the service module is loaded
// ---------------------------------------------------------------------------
const mockCreateSubscription = jest.fn();
const mockCancelSubscription = jest.fn();

const mockSubscriptionsController = {
    createSubscription: mockCreateSubscription,
    cancelSubscription: mockCancelSubscription,
};

jest.mock('../paypal-client', () => ({
    getSubscriptionsController: jest.fn(() => mockSubscriptionsController),
    _resetPaypalClientForTesting: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Stub @vendure/core Logger so we don't need the NestJS DI container
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
import { PaypalSubscriptionService } from '../paypal-subscription.service';
import { _resetPaypalClientForTesting } from '../paypal-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ctx = {} as any; // RequestContext not needed in these unit tests

function makeSubscriptionResponse(id: string, approvalHref: string) {
    return {
        result: {
            id,
            links: [
                { rel: 'self', href: `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${id}` },
                { rel: 'approve', href: approvalHref },
            ],
        },
    };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('PaypalSubscriptionService', () => {
    let service: PaypalSubscriptionService;

    beforeEach(() => {
        jest.clearAllMocks();
        _resetPaypalClientForTesting();
        service = new PaypalSubscriptionService();
    });

    // -------------------------------------------------------------------------
    // createSubscription
    // -------------------------------------------------------------------------
    describe('createSubscription', () => {
        const planId = 'P-TEST-PLAN-ID';
        const returnUrl = 'https://store.com/subscription/return';
        const cancelUrl = 'https://store.com/subscription/cancel';
        const subscriptionId = 'I-TESTSUB00001';
        const approvalUrl = 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-TEST';

        it('returns subscriptionId and approvalUrl on success', async () => {
            mockCreateSubscription.mockResolvedValueOnce(
                makeSubscriptionResponse(subscriptionId, approvalUrl),
            );

            const result = await service.createSubscription(ctx, planId, returnUrl, cancelUrl);

            expect(result).toEqual({ subscriptionId, approvalUrl });
        });

        it('calls createSubscription with planId and redirect URLs', async () => {
            mockCreateSubscription.mockResolvedValueOnce(
                makeSubscriptionResponse(subscriptionId, approvalUrl),
            );

            await service.createSubscription(ctx, planId, returnUrl, cancelUrl);

            expect(mockCreateSubscription).toHaveBeenCalledWith({
                prefer: 'return=representation',
                body: expect.objectContaining({
                    planId,
                    applicationContext: expect.objectContaining({ returnUrl, cancelUrl }),
                }),
            });
        });

        it('throws InternalServerError when result is null/undefined', async () => {
            mockCreateSubscription.mockResolvedValueOnce({ result: null });

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when subscription ID is missing', async () => {
            mockCreateSubscription.mockResolvedValueOnce({
                result: {
                    id: undefined,
                    links: [{ rel: 'approve', href: approvalUrl }],
                },
            });

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when approve link is missing', async () => {
            mockCreateSubscription.mockResolvedValueOnce({
                result: {
                    id: subscriptionId,
                    links: [{ rel: 'self', href: 'https://example.com' }],
                },
            });

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when approve link href is empty string', async () => {
            mockCreateSubscription.mockResolvedValueOnce({
                result: {
                    id: subscriptionId,
                    links: [{ rel: 'approve', href: '' }],
                },
            });

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('throws InternalServerError when links array is absent', async () => {
            mockCreateSubscription.mockResolvedValueOnce({
                result: { id: subscriptionId, links: undefined },
            });

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('wraps PayPal SDK errors in InternalServerError', async () => {
            const sdkError = Object.assign(new Error('PayPal SDK error'), { statusCode: 400 });
            mockCreateSubscription.mockRejectedValueOnce(sdkError);

            await expect(
                service.createSubscription(ctx, planId, returnUrl, cancelUrl),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('re-throws InternalServerError without double-wrapping', async () => {
            // Simulate the case where an inner check already threw InternalServerError
            mockCreateSubscription.mockResolvedValueOnce({ result: null });

            const err = await service.createSubscription(ctx, planId, returnUrl, cancelUrl).catch(e => e);
            expect(err).toBeInstanceOf(InternalServerError);
            // Should NOT be wrapped in another InternalServerError
            expect(err.message).not.toContain('InternalServerError');
        });
    });

    // -------------------------------------------------------------------------
    // cancelSubscription
    // -------------------------------------------------------------------------
    describe('cancelSubscription', () => {
        const subscriptionId = 'I-TESTSUB00001';

        it('returns true when PayPal returns 204 (no exception)', async () => {
            mockCancelSubscription.mockResolvedValueOnce(undefined);

            const result = await service.cancelSubscription(ctx, subscriptionId);

            expect(result).toBe(true);
        });

        it('calls cancelSubscription with the subscription ID', async () => {
            mockCancelSubscription.mockResolvedValueOnce(undefined);

            await service.cancelSubscription(ctx, subscriptionId);

            expect(mockCancelSubscription).toHaveBeenCalledWith(
                expect.objectContaining({ id: subscriptionId }),
            );
        });

        it('passes the reason when provided', async () => {
            mockCancelSubscription.mockResolvedValueOnce(undefined);
            const reason = 'Customer requested cancellation';

            await service.cancelSubscription(ctx, subscriptionId, reason);

            expect(mockCancelSubscription).toHaveBeenCalledWith(
                expect.objectContaining({ id: subscriptionId, body: { reason } }),
            );
        });

        it('omits body when reason is undefined', async () => {
            mockCancelSubscription.mockResolvedValueOnce(undefined);

            await service.cancelSubscription(ctx, subscriptionId, undefined);

            const callArg = mockCancelSubscription.mock.calls[0][0];
            expect(callArg).not.toHaveProperty('body');
        });

        it('omits body when reason is empty string', async () => {
            mockCancelSubscription.mockResolvedValueOnce(undefined);

            await service.cancelSubscription(ctx, subscriptionId, '');

            const callArg = mockCancelSubscription.mock.calls[0][0];
            expect(callArg).not.toHaveProperty('body');
        });

        it('throws InternalServerError when PayPal rejects', async () => {
            mockCancelSubscription.mockRejectedValueOnce(
                Object.assign(new Error('Subscription not found'), { statusCode: 404 }),
            );

            await expect(
                service.cancelSubscription(ctx, subscriptionId),
            ).rejects.toBeInstanceOf(InternalServerError);
        });

        it('includes error message in InternalServerError', async () => {
            const errorMessage = 'Subscription already cancelled';
            mockCancelSubscription.mockRejectedValueOnce(new Error(errorMessage));

            const err = await service.cancelSubscription(ctx, subscriptionId).catch(e => e);
            expect(err).toBeInstanceOf(InternalServerError);
            expect(err.message).toContain(errorMessage);
        });
    });
});
