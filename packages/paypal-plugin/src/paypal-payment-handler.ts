import {
    ApiError,
    CheckoutPaymentIntent,
    CustomError,
    PaypalExperienceUserAction,
} from '@paypal/paypal-server-sdk';
import {
    CreatePaymentResult,
    LanguageCode,
    Logger,
    PaymentMethodHandler,
    SettlePaymentErrorResult,
    SettlePaymentResult,
} from '@vendure/core';

import { getOrdersController, getPaymentsController } from './paypal-client';
import { PaypalPaymentMetadata } from './types';

const loggerCtx = 'PaypalPaymentHandler';

/**
 * Currencies that have no minor unit (i.e. 1 unit = 1 PayPal amount unit).
 * All other currencies are assumed to have 2 decimal places (e.g. USD cents → dollars).
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW',
    'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV',
    'XAF', 'XOF', 'XPF',
]);

function toPaypalAmountValue(amountMinorUnits: number, currencyCode: string): string {
    if (ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())) {
        return String(amountMinorUnits);
    }
    return (amountMinorUnits / 100).toFixed(2);
}

function extractErrorMessage(err: unknown): string {
    if (err instanceof ApiError) {
        if (err instanceof CustomError) {
            return `PayPal API error (${err.statusCode}): ${JSON.stringify(err.result)}`;
        }
        return `PayPal API error (${err.statusCode}): ${String(err.body)}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/**
 * Vendure PaymentMethodHandler for PayPal.
 *
 * ## UC1 – Immediate Capture
 *   createPayment (no `metadata.intent` / `metadata.intent !== 'authorize'`):
 *     Creates a PayPal order with CAPTURE intent.
 *   settlePayment:
 *     Calls captureOrder — captures funds immediately.
 *
 * ## UC2 – Authorize then Capture
 *   createPayment (`metadata.intent === 'authorize'`):
 *     Creates a PayPal order with AUTHORIZE intent — reserves funds without charging.
 *   The storefront then calls `confirmPaypalAuthorization(paypalOrderId)` after buyer
 *   approval, which calls authorizeOrder and saves the authorizationId to payment.metadata.
 *   settlePayment (when payment.metadata.authorizationId is present):
 *     Calls captureAuthorizedPayment — charges the reserved funds.
 *
 * Required storefront metadata for all flows:
 *   - `returnUrl`  URL PayPal redirects to after buyer approval.
 *   - `cancelUrl`  URL PayPal redirects to when buyer cancels.
 *   - `intent`     Optional. Pass `'authorize'` for UC2; omit or pass anything else for UC1.
 */
export const paypalPaymentHandler = new PaymentMethodHandler({
    code: 'paypal',
    description: [{ languageCode: LanguageCode.en, value: 'PayPal' }],
    args: {},

    /**
     * Called when the storefront invokes `addPaymentToOrder` with method = 'paypal'.
     *
     * When `metadata.intent === 'authorize'`, creates a PayPal order with AUTHORIZE intent
     * (UC2 — funds reserved but not captured).  All other values use CAPTURE intent (UC1).
     *
     * On success returns state 'Authorized' with the buyer-approval URL in
     * `metadata.public.approvalUrl` (visible via the Shop API).
     */
    createPayment: async (ctx, order, amount, _args, metadata): Promise<CreatePaymentResult> => {
        const currencyCode = order.currencyCode ?? 'USD';

        // Both URLs are required for PayPal's redirect flow.
        // Without them the PayPal approval page spins indefinitely after the buyer clicks Pay.
        const returnUrl = metadata?.returnUrl as string | undefined;
        const cancelUrl = metadata?.cancelUrl as string | undefined;

        if (!returnUrl || !cancelUrl) {
            const errorMessage =
                'PayPal payment requires returnUrl and cancelUrl in the addPaymentToOrder metadata. ' +
                'Pass the storefront URLs where PayPal should redirect after approval and cancellation.';
            Logger.error(errorMessage, loggerCtx);
            return { amount, state: 'Declined', errorMessage, metadata: { errorMessage } };
        }

        const isAuthorizeIntent = (metadata?.intent as string | undefined) === 'authorize';
        const paypalIntent = isAuthorizeIntent
            ? CheckoutPaymentIntent.Authorize
            : CheckoutPaymentIntent.Capture;

        try {
            const ordersController = getOrdersController();

            const response = await ordersController.createOrder({
                body: {
                    intent: paypalIntent,
                    purchaseUnits: [
                        {
                            referenceId: String(order.id),
                            amount: {
                                currencyCode,
                                value: toPaypalAmountValue(amount, currencyCode),
                            },
                        },
                    ],
                    // paymentSource.paypal.experienceContext is the current (non-deprecated)
                    // way to configure redirect URLs and the checkout button behaviour.
                    paymentSource: {
                        paypal: {
                            experienceContext: {
                                returnUrl,
                                cancelUrl,
                                // PAY_NOW makes the PayPal button say "Pay Now" instead of
                                // "Continue", matching the immediate intent of both UC1 and UC2.
                                userAction: PaypalExperienceUserAction.PayNow,
                            },
                        },
                    },
                },
                prefer: 'return=representation',
            });

            if (!response.result) {
                throw new Error('PayPal returned an empty response for createOrder.');
            }

            const paypalOrder = response.result;
            const paypalOrderId = paypalOrder.id;

            if (!paypalOrderId) {
                throw new Error('PayPal order was created without an ID.');
            }

            // When paymentSource.paypal is supplied (our flow), PayPal uses the
            // Advanced Checkout experience and returns rel='payer-action'.
            // The classic redirect flow (no paymentSource) returns rel='approve'.
            const approveLink =
                paypalOrder.links?.find(l => l.rel === 'payer-action') ??
                paypalOrder.links?.find(l => l.rel === 'approve');

            if (!approveLink?.href) {
                Logger.error(
                    `PayPal order ${paypalOrderId} has no payer-action/approve link. ` +
                        `Links received: ${JSON.stringify(paypalOrder.links)}`,
                    loggerCtx,
                );
                throw new Error(
                    `PayPal order ${paypalOrderId} is missing the buyer-approval link in the response.`,
                );
            }

            const approvalUrl = approveLink.href;

            Logger.info(
                `Created PayPal order ${paypalOrderId} (${isAuthorizeIntent ? 'AUTHORIZE' : 'CAPTURE'} intent) ` +
                    `for Vendure order ${String(order.id)}`,
                loggerCtx,
            );

            return {
                amount,
                state: 'Authorized',
                transactionId: paypalOrderId,
                metadata: {
                    paypalOrderId,
                    public: { approvalUrl },
                },
            };
        } catch (err: unknown) {
            const errorMessage = extractErrorMessage(err);
            Logger.error(
                `Failed to create PayPal order for Vendure order ${String(order.id)}: ${errorMessage}`,
                loggerCtx,
            );
            return {
                amount,
                state: 'Declined',
                errorMessage,
                metadata: { errorMessage },
            };
        }
    },

    /**
     * Called by Vendure's payment state machine when transitioning a payment from
     * 'Authorized' → 'Settled'.
     *
     * UC1 path (no authorizationId in metadata):
     *   Captures the PayPal order directly via captureOrder.
     *
     * UC2 path (authorizationId present in metadata):
     *   Captures the previously-authorized funds via captureAuthorizedPayment.
     *   The authorizationId is written by PaypalService.confirmPaypalAuthorization.
     */
    settlePayment: async (_ctx, order, payment, _args): Promise<SettlePaymentResult | SettlePaymentErrorResult> => {
        const paypalOrderId = payment.transactionId;

        if (!paypalOrderId) {
            return {
                success: false,
                errorMessage: 'No PayPal order ID found on the payment record.',
            };
        }

        const meta = payment.metadata as PaypalPaymentMetadata | null;
        const authorizationId = meta?.authorizationId;

        try {
            if (authorizationId) {
                // UC2: capture previously authorized funds
                const response = await getPaymentsController().captureAuthorizedPayment({
                    authorizationId,
                    prefer: 'return=representation',
                    body: { finalCapture: true },
                });

                if (!response.result) {
                    throw new Error('PayPal returned an empty response for captureAuthorizedPayment.');
                }

                const capturedPayment = response.result;
                const captureId = capturedPayment.id ?? '';
                const captureStatus = capturedPayment.status ? String(capturedPayment.status) : '';

                Logger.info(
                    `Captured PayPal authorization ${authorizationId} for Vendure order ${String(order.id)}. ` +
                        `Capture ID: ${captureId}, Status: ${captureStatus}`,
                    loggerCtx,
                );

                return { success: true, metadata: { captureId, captureStatus } };
            } else {
                // UC1: direct capture of the order
                const response = await getOrdersController().captureOrder({
                    id: paypalOrderId,
                    prefer: 'return=representation',
                });

                if (!response.result) {
                    throw new Error('PayPal returned an empty response for captureOrder.');
                }

                const capturedOrder = response.result;
                const firstCapture =
                    capturedOrder.purchaseUnits?.[0]?.payments?.captures?.[0];

                const captureId = firstCapture?.id ?? '';
                const captureStatus = firstCapture?.status ? String(firstCapture.status) : '';

                Logger.info(
                    `Captured PayPal order ${paypalOrderId} for Vendure order ${String(order.id)}. ` +
                        `Capture ID: ${captureId}, Status: ${captureStatus}`,
                    loggerCtx,
                );

                return { success: true, metadata: { captureId, captureStatus } };
            }
        } catch (err: unknown) {
            const errorMessage = extractErrorMessage(err);
            Logger.error(
                `Failed to settle PayPal payment for Vendure order ${String(order.id)}: ${errorMessage}`,
                loggerCtx,
            );
            return { success: false, errorMessage };
        }
    },
});
