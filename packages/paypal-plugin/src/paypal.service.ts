import { Injectable } from '@nestjs/common';
import {
    ID,
    InternalServerError,
    Logger,
    Order,
    Payment,
    PaymentService,
    PaymentStateTransitionError,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { getOrdersController } from './paypal-client';

const loggerCtx = 'PaypalService';

@Injectable()
export class PaypalService {
    constructor(
        private readonly paymentService: PaymentService,
        private readonly connection: TransactionalConnection,
    ) {}

    /**
     * UC1 – Confirms buyer approval of a PayPal payment and captures funds immediately.
     *
     * Flow:
     *  1. Look up the Vendure Payment by its PayPal order ID (stored as `transactionId`).
     *  2. Verify the requesting user owns the payment's order.
     *  3. Delegate to PaymentService.settlePayment, which calls the handler's
     *     `settlePayment` method (→ PayPal captureOrder) and transitions state to 'Settled'.
     */
    async confirmPaypalCapture(ctx: RequestContext, paypalOrderId: string): Promise<Order> {
        Logger.info(
            `Confirming PayPal capture for PayPal order ID: ${paypalOrderId}`,
            loggerCtx,
        );

        const payment = await this.findPaymentByOrderId(ctx, paypalOrderId);

        this.assertOwnership(ctx, payment);

        if (payment.state !== 'Authorized') {
            throw new InternalServerError(
                `Payment is in state '${payment.state}' and cannot be settled. ` +
                    `Only 'Authorized' payments may be captured.`,
            );
        }

        const result = await this.paymentService.settlePayment(ctx, payment.id);

        if (result instanceof PaymentStateTransitionError) {
            Logger.error(
                `Failed to settle payment ${String(payment.id)}: ${result.message}`,
                loggerCtx,
            );
            throw new InternalServerError(result.message);
        }

        Logger.info(
            `Payment ${String(payment.id)} settled successfully for PayPal order ${paypalOrderId}.`,
            loggerCtx,
        );

        return payment.order;
    }

    /**
     * UC2 – Confirms buyer approval of a PayPal AUTHORIZE-intent order, reserves the funds,
     * and stores the resulting authorizationId on the payment for later capture.
     *
     * Flow:
     *  1. Look up the Vendure Payment by its PayPal order ID.
     *  2. Verify the requesting user owns the payment.
     *  3. Call PayPal authorizeOrder — reserves the funds without charging the buyer.
     *  4. Extract the authorizationId from the response and persist it to payment.metadata.
     *     The payment remains in 'Authorized' state until the merchant settles it.
     *
     * The merchant later triggers settlement (e.g. on shipment) via Vendure's payment
     * state machine, which calls the handler's settlePayment → captureAuthorizedPayment.
     */
    async confirmPaypalAuthorization(ctx: RequestContext, paypalOrderId: string): Promise<boolean> {
        Logger.info(
            `Confirming PayPal authorization for PayPal order ID: ${paypalOrderId}`,
            loggerCtx,
        );

        const payment = await this.findPaymentByOrderId(ctx, paypalOrderId);

        this.assertOwnership(ctx, payment);

        if (payment.state !== 'Authorized') {
            throw new InternalServerError(
                `Payment is in state '${payment.state}' and cannot be authorized. ` +
                    `Only 'Authorized' payments may proceed with authorization.`,
            );
        }

        const response = await getOrdersController().authorizeOrder({
            id: paypalOrderId,
            prefer: 'return=representation',
        });

        if (!response.result) {
            throw new InternalServerError(
                'PayPal returned an empty response for authorizeOrder.',
            );
        }

        const firstAuthorization =
            response.result.purchaseUnits?.[0]?.payments?.authorizations?.[0];
        const authorizationId = firstAuthorization?.id;
        const authorizationStatus = firstAuthorization?.status
            ? String(firstAuthorization.status)
            : undefined;

        if (!authorizationId) {
            throw new InternalServerError(
                `PayPal authorizeOrder response for order ${paypalOrderId} does not contain an authorization ID.`,
            );
        }

        // Persist the authorizationId so settlePayment knows to use captureAuthorizedPayment.
        payment.metadata = {
            ...(payment.metadata as Record<string, unknown>),
            authorizationId,
            ...(authorizationStatus !== undefined ? { authorizationStatus } : {}),
        };
        await this.connection.getRepository(ctx, Payment).save(payment);

        Logger.info(
            `PayPal funds reserved for order ${paypalOrderId}. Authorization ID: ${authorizationId}`,
            loggerCtx,
        );

        return true;
    }

    private async findPaymentByOrderId(ctx: RequestContext, paypalOrderId: string): Promise<Payment & { order: Order }> {
        const payment = await this.connection
            .getRepository(ctx, Payment)
            .findOne({
                where: { transactionId: paypalOrderId },
                relations: [
                    'order',
                    'order.lines',
                    'order.customer',
                    'order.customer.user',
                ],
            });

        if (!payment) {
            throw new InternalServerError(
                `No payment found matching PayPal order ID: ${paypalOrderId}`,
            );
        }

        return payment as Payment & { order: Order };
    }

    private assertOwnership(ctx: RequestContext, payment: Payment & { order: Order }): void {
        if (!ctx.activeUserId) return;

        const ownerUserId = (payment.order as any)?.customer?.user?.id as ID | undefined;
        if (ownerUserId !== undefined && ownerUserId !== ctx.activeUserId) {
            Logger.warn(
                `User ${String(ctx.activeUserId)} attempted to confirm a payment belonging ` +
                    `to user ${String(ownerUserId)}. Request denied.`,
                loggerCtx,
            );
            throw new InternalServerError('Unauthorized');
        }
    }
}
