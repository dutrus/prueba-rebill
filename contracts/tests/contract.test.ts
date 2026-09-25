import { stepA, stepB_buggy, stepB_fixed, stepC_validateContract } from '../services/pipeline';

describe('Contrato entre paso B y paso C', () => {
  const inputFromClient = {
    customer_id: 'cust_123',
    amount: 5000,
    currency: 'ARS',
    idempotency_key: 'idem_abc',
  };

  it('reproduce el incidente real: si B no manda customer_id, el contrato falla en C (no en el proveedor)', () => {
    const fromA = stepA(inputFromClient);
    const fromB = stepB_buggy(fromA); // simula el bug: no propaga customer_id

    expect(() => stepC_validateContract(fromB)).toThrow();
    // Este es exactamente el punto donde el harness bloquearía el merge:
    // el error aparece acá, en CI, no en producción con un cliente real.
  });

  it('con el fix aplicado, el payload de B cumple el contrato que C necesita', () => {
    const fromA = stepA(inputFromClient);
    const fromB = stepB_fixed(fromA);

    expect(() => stepC_validateContract(fromB)).not.toThrow();

    const validated = stepC_validateContract(fromB);
    expect(validated.customer_id).toBe('cust_123');
  });
});
