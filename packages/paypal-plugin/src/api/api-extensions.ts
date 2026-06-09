import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    extend type Mutation {
        """
        UC1 – Confirms buyer approval of a PayPal CAPTURE-intent payment and captures the funds.

        Call this after the buyer has been redirected back from the PayPal approval page.
        Pass the PayPal order ID, which PayPal appends as the \`token\` query parameter on
        the \`returnUrl\` you supplied when creating the payment.

        On success the Vendure payment transitions to 'Settled' and the order moves to
        'PaymentSettled'.

        **Required prior step:** call \`addPaymentToOrder\` with
        \`metadata: { returnUrl: "...", cancelUrl: "..." }\`.
        """
        confirmPaypalPayment(paypalOrderId: String!): Boolean!

        """
        UC2 – Confirms buyer approval of a PayPal AUTHORIZE-intent payment and reserves the funds.

        Call this after the buyer has been redirected back from the PayPal approval page when
        the payment was created with \`metadata: { intent: "authorize", ... }\`.

        This reserves the funds on the buyer's account without capturing them.  The payment
        remains in 'Authorized' state.  The merchant captures the reserved funds later (e.g.
        on shipment) by triggering Vendure's payment settlement flow.

        **Required prior step:** call \`addPaymentToOrder\` with
        \`metadata: { intent: "authorize", returnUrl: "...", cancelUrl: "..." }\`.
        """
        confirmPaypalAuthorization(paypalOrderId: String!): Boolean!
    }
`;
