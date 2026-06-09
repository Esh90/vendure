import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';

import { PaypalSubscriptionInfo, PaypalSubscriptionService } from '../paypal-subscription.service';
import { PaypalService } from '../paypal.service';

@Resolver()
export class PaypalShopResolver {
    constructor(
        private readonly paypalService: PaypalService,
        private readonly paypalSubscriptionService: PaypalSubscriptionService,
    ) {}

    /**
     * UC1 – Capture funds immediately after buyer approval.
     * Transitions the Vendure payment from 'Authorized' to 'Settled'.
     */
    @Mutation()
    @Allow(Permission.Authenticated)
    async confirmPaypalPayment(
        @Ctx() ctx: RequestContext,
        @Args() args: { paypalOrderId: string },
    ): Promise<boolean> {
        await this.paypalService.confirmPaypalCapture(ctx, args.paypalOrderId);
        return true;
    }

    /**
     * UC2 – Reserve funds after buyer approves an AUTHORIZE-intent PayPal order.
     * Saves the authorizationId to payment metadata; payment stays in 'Authorized' state.
     * Capture happens later when the merchant settles the payment (e.g. on shipment).
     */
    @Mutation()
    @Allow(Permission.Authenticated)
    async confirmPaypalAuthorization(
        @Ctx() ctx: RequestContext,
        @Args() args: { paypalOrderId: string },
    ): Promise<boolean> {
        return this.paypalService.confirmPaypalAuthorization(ctx, args.paypalOrderId);
    }

    /**
     * UC3 – Cancel a pending PayPal payment before capture.
     * Voids the PayPal authorization (if present) and transitions the Vendure payment to 'Cancelled'.
     */
    @Mutation()
    @Allow(Permission.Authenticated)
    async cancelPaypalOrder(
        @Ctx() ctx: RequestContext,
        @Args() args: { paypalOrderId: string },
    ): Promise<boolean> {
        return this.paypalService.cancelPaypalOrder(ctx, args.paypalOrderId);
    }

    /**
     * UC6 – Create a PayPal subscription for an existing billing plan.
     * Returns the subscriptionId and the approvalUrl the buyer must visit.
     */
    @Mutation()
    @Allow(Permission.Authenticated)
    async createPaypalSubscription(
        @Ctx() ctx: RequestContext,
        @Args() args: { planId: string; returnUrl: string; cancelUrl: string },
    ): Promise<PaypalSubscriptionInfo> {
        return this.paypalSubscriptionService.createSubscription(
            ctx,
            args.planId,
            args.returnUrl,
            args.cancelUrl,
        );
    }

    /**
     * UC6 – Cancel an active PayPal subscription.
     * Returns true on success; throws on failure.
     */
    @Mutation()
    @Allow(Permission.Authenticated)
    async cancelPaypalSubscription(
        @Ctx() ctx: RequestContext,
        @Args() args: { subscriptionId: string; reason?: string },
    ): Promise<boolean> {
        return this.paypalSubscriptionService.cancelSubscription(
            ctx,
            args.subscriptionId,
            args.reason,
        );
    }
}
