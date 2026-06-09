import {
    Client,
    Environment,
    LogLevel,
    OrdersController,
    PaymentsController,
    SubscriptionsController,
    TransactionSearchController,
} from '@paypal/paypal-server-sdk';

let sharedClient: Client | null = null;
let ordersController: OrdersController | null = null;
let paymentsController: PaymentsController | null = null;
let subscriptionsController: SubscriptionsController | null = null;
let transactionSearchController: TransactionSearchController | null = null;

function getClient(): Client {
    if (!sharedClient) {
        const clientId = process.env.PAYPAL_CLIENT_ID;
        const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            throw new Error(
                '[PayPal] PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in environment variables.',
            );
        }

        const environment =
            process.env.PAYPAL_ENVIRONMENT === 'production'
                ? Environment.Production
                : Environment.Sandbox;

        sharedClient = new Client({
            clientCredentialsAuthCredentials: {
                oAuthClientId: clientId,
                oAuthClientSecret: clientSecret,
            },
            timeout: 0,
            environment,
            logging: {
                logLevel: LogLevel.Info,
                logRequest: { logBody: false },
                logResponse: { logHeaders: false },
            },
        });
    }
    return sharedClient;
}

/**
 * Returns a singleton OrdersController backed by the shared PayPal Client.
 * Reads credentials and environment from process.env on first call.
 */
export function getOrdersController(): OrdersController {
    if (!ordersController) {
        ordersController = new OrdersController(getClient());
    }
    return ordersController;
}

/**
 * Returns a singleton PaymentsController backed by the shared PayPal Client.
 * Used for authorize-then-capture (UC2) and void flows.
 */
export function getPaymentsController(): PaymentsController {
    if (!paymentsController) {
        paymentsController = new PaymentsController(getClient());
    }
    return paymentsController;
}

/**
 * Returns a singleton SubscriptionsController backed by the shared PayPal Client.
 * Used for subscription billing (UC6): create/cancel subscriptions and billing plans.
 */
export function getSubscriptionsController(): SubscriptionsController {
    if (!subscriptionsController) {
        subscriptionsController = new SubscriptionsController(getClient());
    }
    return subscriptionsController;
}

/**
 * Returns a singleton TransactionSearchController backed by the shared PayPal Client.
 * Used for transaction reporting (UC7): search and list PayPal transactions.
 */
export function getTransactionSearchController(): TransactionSearchController {
    if (!transactionSearchController) {
        transactionSearchController = new TransactionSearchController(getClient());
    }
    return transactionSearchController;
}

/** Resets all singletons — for use in unit tests only. */
export function _resetPaypalClientForTesting(): void {
    sharedClient = null;
    ordersController = null;
    paymentsController = null;
    subscriptionsController = null;
    transactionSearchController = null;
}
