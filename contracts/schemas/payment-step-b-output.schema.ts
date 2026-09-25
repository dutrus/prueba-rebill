import { z } from 'zod';

/**
 * Contrato: esto es lo que el Paso C (y, en última instancia, el proveedor
 * de pago) necesitan recibir del Paso B.
 *
 * Si un cambio en B deja de propagar alguno de estos campos, este schema
 * lo detecta en CI, antes de que el request llegue al proveedor real con
 * un cliente esperando del otro lado.
 */
export const stepBOutputSchema = z.object({
  payment_id: z.string().uuid(),
  idempotency_key: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3), // ISO 4217, ej: "USD", "ARS"
  customer_id: z.string().min(1), // el parámetro que se perdió en el incidente real
});

export type StepBOutput = z.infer<typeof stepBOutputSchema>;
