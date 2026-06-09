import { Injectable } from '@nestjs/common';
import { ApiError, SubscriptionError } from '@paypal/paypal-server-sdk';
import { InternalServerError, Logger, RequestContext } from '@vendure/core';

import { getSubscriptionsController } from './paypal-client';

const loggerCtx = 'PaypalSubscriptionService';

export interface PaypalSubscriptionInfo {
    subscriptionId: string;
    approvalUrl: string;
}

function extractSubscriptionErrorMessage(err: unknown): string {
    if (err instanceof SubscriptionError) {
        return `PayPal Subscription error (${err.statusCode}): ${JSON.stringify(err.result)}`;
    }
    if (err instanceof ApiError) {
        return `PayPal API error (${err.statusCode}): ${String(err.body)}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

@Injectable()
export class PaypalSubscriptionService {
    /**
     * UC6 – Creates a PayPal subscription for an existing billing plan.
     *
     * Prerequisites:
     *   A PayPal billing plan must already exist (created via the PayPal dashboard or
     *   `createPaypalBillingPlan` if exposed via the Admin API).
     *
     * Flow:
     *   1. Call `createSubscription` with the planId and redirect URLs.
     *   2. Extract the `approve` link from the response — the buyer must visit this URL.
     *   3. After the buyer approves on PayPal, the subscription becomes ACTIVE and PayPal
     *      redirects to `returnUrl` with the `subscription_id` query parameter.
     *
     * @param _ctx       - Request context (unused; reserved for future ownership checks).
     * @param planId     - The PayPal billing plan ID to subscribe to.
     * @param returnUrl  - Where PayPal redirects the buyer after approval.
     * @param cancelUrl  - Where PayPal redirects the buyer if they cancel on the PayPal page.
     */
    async createSubscription(
        _ctx: RequestContext,
        planId: string,
        returnUrl: string,
        cancelUrl: string,
    ): Promise<PaypalSubscriptionInfo> {
        Logger.info(`Creating PayPal subscription for plan ${planId}`, loggerCtx);

        try {
            const response = await getSubscriptionsController().createSubscription({
                prefer: 'return=representation',
                body: {
                    planId,
                    // applicationContext is the current (though deprecated) field for
                    // redirect URLs in subscriptions. No non-deprecated alternative exists.
                    applicationContext: {
                        returnUrl,
                        cancelUrl,
                    } as any,
                },
            });

            if (!response.result) {
                throw new InternalServerError(
                    'PayPal returned an empty response for createSubscription.',
                );
            }

            const subscription = response.result;
            const subscriptionId = subscription.id;

            if (!subscriptionId) {
                throw new InternalServerError(
                    'PayPal subscription was created without an ID.',
                );
            }

            const approveLink = subscription.links?.find(l => l.rel === 'approve');

            if (!approveLink?.href) {
                Logger.error(
                    `PayPal subscription ${subscriptionId} has no approve link. ` +
                        `Links received: ${JSON.stringify(subscription.links)}`,
                    loggerCtx,
                );
                throw new InternalServerError(
                    `PayPal subscription ${subscriptionId} is missing the buyer-approval link.`,
                );
            }

            Logger.info(
                `Created PayPal subscription ${subscriptionId} for plan ${planId}.`,
                loggerCtx,
            );

            return { subscriptionId, approvalUrl: approveLink.href };
        } catch (err: unknown) {
            if (err instanceof InternalServerError) {
                throw err;
            }
            const message = extractSubscriptionErrorMessage(err);
            Logger.error(
                `Failed to create PayPal subscription for plan ${planId}: ${message}`,
                loggerCtx,
            );
            throw new InternalServerError(message);
        }
    }

    /**
     * UC6 – Cancels an active PayPal subscription.
     *
     * The caller must own the subscription. PayPal enforces ownership server-side
     * and returns 403 if the caller's credentials do not match the subscription.
     *
     * @param _ctx           - Request context (unused; reserved for future ownership checks).
     * @param subscriptionId - The PayPal subscription ID to cancel.
     * @param reason         - Optional human-readable cancellation reason shown to the buyer.
     */
    async cancelSubscription(
        _ctx: RequestContext,
        subscriptionId: string,
        reason?: string,
    ): Promise<boolean> {
        Logger.info(`Cancelling PayPal subscription ${subscriptionId}`, loggerCtx);

        try {
            // cancelSubscription returns void (204 No Content).
            // Success is determined solely by the absence of an exception.
            await getSubscriptionsController().cancelSubscription({
                id: subscriptionId,
                ...(reason ? { body: { reason } } : {}),
            });

            Logger.info(`PayPal subscription ${subscriptionId} cancelled.`, loggerCtx);
            return true;
        } catch (err: unknown) {
            const message = extractSubscriptionErrorMessage(err);
            Logger.error(
                `Failed to cancel PayPal subscription ${subscriptionId}: ${message}`,
                loggerCtx,
            );
            throw new InternalServerError(message);
        }
    }
}
