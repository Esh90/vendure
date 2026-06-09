/**
 * Metadata stored on a Vendure Payment entity for a PayPal transaction.
 * The `public` sub-object is visible to the storefront via the Shop API.
 */
export interface PaypalPaymentMetadata {
    paypalOrderId: string;
    public: {
        approvalUrl: string;
    };
    /** UC1: ID of the direct capture performed by captureOrder. */
    captureId?: string;
    captureStatus?: string;
    /**
     * UC2: Authorization ID reserved by authorizeOrder after buyer approval.
     * When present, settlePayment uses captureAuthorizedPayment instead of captureOrder.
     */
    authorizationId?: string;
    authorizationStatus?: string;
}
