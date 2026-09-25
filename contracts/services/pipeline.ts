import { randomUUID } from 'crypto';
import { StepBOutput, stepBOutputSchema } from '../schemas/payment-step-b-output.schema';

/**
 * Store en memoria simulando la tabla de pagos.
 * Clave: idempotency_key -> resultado ya creado para ese intento.
 */
const paymentStore = new Map<string, { payment_id: string; status: string }>();

export function resetPaymentStore() {
  paymentStore.clear();
}

type ClientInput = {
  customer_id: string;
  amount: number;
  currency: string;
  idempotency_key: string;
};

/**
 * Paso A: recibe la request del cliente y arma el payload base.
 */
export function stepA(input: ClientInput) {
  return {
    customer_id: input.customer_id,
    amount: input.amount,
    currency: input.currency,
    idempotency_key: input.idempotency_key,
  };
}

/**
 * Paso B tal como funcionaba en el incidente real (con el bug):
 * arma el payload para el proveedor pero deja de propagar customer_id.
 * Se mantiene acá, intencionalmente, para reproducir el bug en el
 * contract test.
 */
export function stepB_buggy(payloadFromA: ReturnType<typeof stepA>): Partial<StepBOutput> {
  return {
    payment_id: randomUUID(),
    idempotency_key: payloadFromA.idempotency_key,
    amount: payloadFromA.amount,
    currency: payloadFromA.currency,
    // customer_id: payloadFromA.customer_id,  <- esto es lo que faltaba en el bug real
  };
}

/**
 * Paso B corregido: propaga todo lo que C necesita.
 */
export function stepB_fixed(payloadFromA: ReturnType<typeof stepA>): StepBOutput {
  return {
    payment_id: randomUUID(),
    idempotency_key: payloadFromA.idempotency_key,
    amount: payloadFromA.amount,
    currency: payloadFromA.currency,
    customer_id: payloadFromA.customer_id,
  };
}

/**
 * Paso C: valida el contrato antes de mandarle algo al proveedor.
 * Si el payload no cumple el schema, lanza un error ACÁ, no en el
 * proveedor de pago tres pasos después.
 */
export function stepC_validateContract(payload: unknown): StepBOutput {
  return stepBOutputSchema.parse(payload);
}

/**
 * createPayment simula el orquestador completo, con idempotencia real:
 * si ya existe un intento con ese idempotency_key, devuelve el mismo
 * resultado en vez de crear un pago nuevo.
 */
export function createPayment(input: ClientInput) {
  const existing = paymentStore.get(input.idempotency_key);
  if (existing) {
    return existing; // mismo intento, no se crea uno nuevo
  }

  const fromA = stepA(input);
  const fromB = stepB_fixed(fromA);
  const validated = stepC_validateContract(fromB); // acá explota si falta algo

  const result = { payment_id: validated.payment_id, status: 'CREATED' };
  paymentStore.set(input.idempotency_key, result);
  return result;
}
