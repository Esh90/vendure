import {
    LanguageCode,
    Logger,
    PaymentMethod,
    PaymentMethodService,
    PluginCommonModule,
    RequestContextService,
    TransactionalConnection,
    VendurePlugin,
} from '@vendure/core';
import { OnApplicationBootstrap } from '@nestjs/common';

import { shopApiExtensions } from './api/api-extensions';
import { PaypalShopResolver } from './api/paypal-shop.resolver';
import { paypalPaymentHandler } from './paypal-payment-handler';
import { PaypalSubscriptionService } from './paypal-subscription.service';
import { PaypalService } from './paypal.service';

const loggerCtx = 'PaypalPlugin';

/**
 * @description
 * Vendure plugin that integrates PayPal as a payment provider.
 *
 * ## Setup
 *
 * 1. Add the plugin to your `VendureConfig`:
 * ```ts
 * import { PaypalPlugin } from '@vendure/paypal-plugin';
 *
 * export const config: VendureConfig = {
 *   plugins: [PaypalPlugin],
 * };
 * ```
 *
 * 2. Set the required environment variables:
 * ```
 * PAYPAL_CLIENT_ID=<your-client-id>
 * PAYPAL_CLIENT_SECRET=<your-client-secret>
 * PAYPAL_ENVIRONMENT=sandbox   # or "production"
 * ```
 *
 * 3. The plugin auto-creates a `paypal` PaymentMethod on first boot.
 *    You can also create / configure it manually via the Admin UI.
 *
 * ## UC1 – Immediate Capture
 *
 * ```graphql
 * # 1. Add PayPal payment to order (no intent field → CAPTURE)
 * mutation {
 *   addPaymentToOrder(input: {
 *     method: "paypal",
 *     metadata: { returnUrl: "https://store.com/return", cancelUrl: "https://store.com/cancel" }
 *   }) {
 *     ... on Order { payments { id state metadata } }
 *   }
 * }
 *
 * # 2. Redirect buyer to payment.metadata.public.approvalUrl
 * #    PayPal redirects back to returnUrl?token=<paypalOrderId>
 *
 * # 3. Capture funds after buyer returns
 * mutation { confirmPaypalPayment(paypalOrderId: "<token>") }
 * ```
 *
 * ## UC2 – Authorize then Capture (reserve now, charge later)
 *
 * ```graphql
 * # 1. Add PayPal payment with authorize intent
 * mutation {
 *   addPaymentToOrder(input: {
 *     method: "paypal",
 *     metadata: {
 *       intent: "authorize",
 *       returnUrl: "https://store.com/return",
 *       cancelUrl: "https://store.com/cancel"
 *     }
 *   }) {
 *     ... on Order { payments { id state metadata } }
 *   }
 * }
 *
 * # 2. Redirect buyer to payment.metadata.public.approvalUrl
 *
 * # 3. Reserve funds after buyer returns (payment stays 'Authorized')
 * mutation { confirmPaypalAuthorization(paypalOrderId: "<token>") }
 *
 * # 4. Capture reserved funds when merchant ships (via Admin API or service)
 * #    Vendure PaymentService.settlePayment(ctx, paymentId) → captureAuthorizedPayment
 * ```
 *
 * ## UC3 – Cancellation / Void (cancel before capture)
 *
 * ```graphql
 * # Storefront: cancel a pending payment (voids authorization if UC2, no-op for UC1)
 * mutation { cancelPaypalOrder(paypalOrderId: "<token>") }
 *
 * # Admin: cancel via Vendure Admin API (same handler invoked)
 * mutation { cancelPayment(id: "<vendurePaymentId>") }
 * ```
 *
 * ## UC4 – Full Refund / UC5 – Partial Refund (Admin-initiated via refundOrder)
 *
 * ```graphql
 * # Admin: issue a full or partial refund via the Vendure Admin API
 * # Vendure calls createRefund handler → PayPal refundCapturedPayment
 * # Full refund: amount === payment.amount (no body sent to PayPal)
 * # Partial refund: amount < payment.amount (body with amount sent to PayPal)
 * mutation {
 *   refundOrder(input: {
 *     lines: [...],
 *     reason: "Customer request",
 *     paymentId: "<vendurePaymentId>",
 *     adjustment: 0,
 *     shipping: 0
 *   }) { ... }
 * }
 * ```
 *
 * ## UC6 – Subscription Billing
 *
 * ```graphql
 * # 1. Create a subscription (billing plan must already exist in your PayPal account)
 * mutation {
 *   createPaypalSubscription(
 *     planId:    "P-XXXXXXXXXXXX"
 *     returnUrl: "https://store.com/subscription/return"
 *     cancelUrl: "https://store.com/subscription/cancel"
 *   ) {
 *     subscriptionId
 *     approvalUrl
 *   }
 * }
 *
 * # 2. Redirect the buyer to `approvalUrl`.
 * #    PayPal redirects back to returnUrl?subscription_id=<subscriptionId>
 *
 * # 3. Cancel the subscription at any time
 * mutation {
 *   cancelPaypalSubscription(
 *     subscriptionId: "<subscriptionId>"
 *     reason: "Customer request"
 *   )
 * }
 * ```
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [PaypalService, PaypalSubscriptionService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [PaypalShopResolver],
    },
    configuration: config => {
        config.paymentOptions.paymentMethodHandlers.push(paypalPaymentHandler);
        return config;
    },
})
export class PaypalPlugin implements OnApplicationBootstrap {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly requestContextService: RequestContextService,
        private readonly paymentMethodService: PaymentMethodService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.ensurePaypalPaymentMethodExists();
    }

    /**
     * Creates the default PayPal PaymentMethod in the database if none exists yet.
     * This allows the storefront to use PayPal without any manual Admin UI setup.
     */
    private async ensurePaypalPaymentMethodExists(): Promise<void> {
        const existing = await this.connection.rawConnection
            .getRepository(PaymentMethod)
            .findOne({ where: { code: paypalPaymentHandler.code } });

        if (!existing) {
            const ctx = await this.requestContextService.create({ apiType: 'admin' });
            await this.paymentMethodService.create(ctx, {
                code: paypalPaymentHandler.code,
                enabled: true,
                handler: {
                    code: paypalPaymentHandler.code,
                    arguments: [],
                },
                translations: [
                    {
                        languageCode: LanguageCode.en,
                        name: 'PayPal',
                    },
                ],
            });
            Logger.info('Created default PayPal payment method.', loggerCtx);
        }
    }
}
