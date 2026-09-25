import { createPayment, resetPaymentStore } from '../services/pipeline';

describe('Idempotencia en la creación de pagos', () => {
  beforeEach(() => {
    resetPaymentStore();
  });

  it('la misma request repetida 5 veces con el mismo idempotency_key crea un solo pago', () => {
    const input = {
      customer_id: 'cust_123',
      amount: 5000,
      currency: 'ARS',
      idempotency_key: 'idem_same_key',
    };

    const results = Array.from({ length: 5 }, () => createPayment(input));

    const uniquePaymentIds = new Set(results.map((r) => r.payment_id));
    expect(uniquePaymentIds.size).toBe(1); // un solo payment_id, no cinco
  });

  it('requests con distinto idempotency_key sí generan pagos distintos', () => {
    const base = { customer_id: 'cust_123', amount: 5000, currency: 'ARS' };

    const p1 = createPayment({ ...base, idempotency_key: 'idem_1' });
    const p2 = createPayment({ ...base, idempotency_key: 'idem_2' });

    expect(p1.payment_id).not.toBe(p2.payment_id);
  });
});
