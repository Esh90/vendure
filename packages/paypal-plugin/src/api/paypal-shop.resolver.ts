import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';

import { PaypalService } from '../paypal.service';

@Resolver()
export class PaypalShopResolver {
    constructor(private readonly paypalService: PaypalService) {}

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
}
