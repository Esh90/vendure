import { Injectable } from '@nestjs/common';
import { ApiError, CustomError, PatchOp, ShipmentCarrier } from '@paypal/paypal-server-sdk';
import { InternalServerError, Logger, RequestContext } from '@vendure/core';

import { getOrdersController } from './paypal-client';

const loggerCtx = 'PaypalTrackingService';

// ─── Public DTO types ────────────────────────────────────────────────────────

export interface PaypalShipmentTrackingInput {
    /** PayPal order ID (stored as payment.transactionId in Vendure). */
    paypalOrderId: string;
    /** PayPal capture ID (stored as payment.metadata.captureId in Vendure). */
    captureId: string;
    /** Carrier tracking number provided by the fulfillment partner. */
    trackingNumber: string;
    /**
     * Carrier code — must be a valid PayPal ShipmentCarrier enum value.
     * Use "OTHER" for carriers not in the PayPal list and set carrierNameOther.
     */
    carrier: string;
    /** Required when carrier is "OTHER". */
    carrierNameOther?: string;
    /** Whether PayPal should e-mail the buyer with tracking details. */
    notifyPayer?: boolean;
}

export interface PaypalTrackingResult {
    /** The PayPal-generated tracker ID (format: `<orderId>-<captureId>`). */
    trackerId: string;
    /** Shipment status returned by PayPal — typically "SHIPPED". */
    status: string;
}

// ─── Error helper ────────────────────────────────────────────────────────────

function extractErrorMessage(err: unknown): string {
    if (err instanceof CustomError) {
        return `PayPal error (${err.statusCode}): ${JSON.stringify(err.result)}`;
    }
    if (err instanceof ApiError) {
        return `PayPal API error (${err.statusCode}): ${String(err.body)}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class PaypalTrackingService {
    /**
     * UC8 – Adds shipment tracking information to a captured PayPal order.
     *
     * Call this after the order has been fulfilled and a tracking number is available.
     * PayPal will optionally notify the buyer by email if `notifyPayer` is true.
     *
     * The `captureId` must be the PayPal capture ID stored in
     * `payment.metadata.captureId` when the payment was settled (UC1/UC2).
     *
     * @param _ctx  - Request context (reserved for future auth checks).
     * @param input - Tracking details.
     * @returns     Tracker ID and status ("SHIPPED").
     */
    async addShipmentTracking(
        _ctx: RequestContext,
        input: PaypalShipmentTrackingInput,
    ): Promise<PaypalTrackingResult> {
        const {
            paypalOrderId,
            captureId,
            trackingNumber,
            carrier,
            carrierNameOther,
            notifyPayer = false,
        } = input;

        Logger.info(
            `Adding shipment tracking to PayPal order ${paypalOrderId} ` +
                `(captureId: ${captureId}, carrier: ${carrier}, tracking: ${trackingNumber})`,
            loggerCtx,
        );

        try {
            const response = await getOrdersController().createOrderTracking({
                id: paypalOrderId,
                body: {
                    captureId,
                    trackingNumber,
                    carrier: carrier as ShipmentCarrier,
                    ...(carrier === 'OTHER' && carrierNameOther
                        ? { carrierNameOther }
                        : {}),
                    notifyPayer,
                },
            });

            if (!response.result) {
                throw new InternalServerError(
                    `PayPal returned an empty response when adding tracking to order ${paypalOrderId}.`,
                );
            }

            // The tracker is returned nested inside the Order's first purchase unit.
            const tracker = response.result.purchaseUnits?.[0]?.shipping?.trackers?.[0];

            if (!tracker?.id) {
                Logger.error(
                    `PayPal accepted the tracking request for order ${paypalOrderId} ` +
                        `but returned no tracker ID. Response: ${JSON.stringify(response.result)}`,
                    loggerCtx,
                );
                throw new InternalServerError(
                    `Tracking was added to order ${paypalOrderId} but PayPal did not return a tracker ID.`,
                );
            }

            const trackerId = tracker.id;
            const status = tracker.status ?? 'SHIPPED';

            Logger.info(
                `Shipment tracking added to PayPal order ${paypalOrderId}. ` +
                    `Tracker ID: ${trackerId}, status: ${status}`,
                loggerCtx,
            );

            return { trackerId, status };
        } catch (err: unknown) {
            if (err instanceof InternalServerError) {
                throw err;
            }
            const message = extractErrorMessage(err);
            Logger.error(
                `Failed to add tracking to PayPal order ${paypalOrderId}: ${message}`,
                loggerCtx,
            );
            throw new InternalServerError(message);
        }
    }

    /**
     * UC8 – Cancels an existing shipment tracker on a PayPal order.
     *
     * This patches the tracker status to CANCELLED via `updateOrderTracking`.
     * PayPal returns 204 No Content on success — success is the absence of an exception.
     *
     * @param _ctx         - Request context (reserved for future auth checks).
     * @param paypalOrderId - PayPal order ID the tracker belongs to.
     * @param trackerId    - The tracker ID returned by `addShipmentTracking`.
     */
    async cancelShipmentTracking(
        _ctx: RequestContext,
        paypalOrderId: string,
        trackerId: string,
    ): Promise<boolean> {
        Logger.info(
            `Cancelling shipment tracker ${trackerId} on PayPal order ${paypalOrderId}`,
            loggerCtx,
        );

        try {
            // updateOrderTracking returns 204 No Content.
            // Success is determined solely by the absence of an exception.
            await getOrdersController().updateOrderTracking({
                id: paypalOrderId,
                trackerId,
                body: [
                    {
                        op: PatchOp.Replace,
                        path: '/status',
                        value: 'CANCELLED',
                    },
                ],
            });

            Logger.info(
                `Shipment tracker ${trackerId} on PayPal order ${paypalOrderId} cancelled.`,
                loggerCtx,
            );
            return true;
        } catch (err: unknown) {
            const message = extractErrorMessage(err);
            Logger.error(
                `Failed to cancel tracker ${trackerId} on PayPal order ${paypalOrderId}: ${message}`,
                loggerCtx,
            );
            throw new InternalServerError(message);
        }
    }
}
