# Contratos e idempotencia: artefactos de ejemplo

Esta carpeta complementa `analisis.md` con código chico: un contract test entre pasos y un test de idempotencia. No es el payment gateway completo. Es mínimo a propósito, para mostrar que el diseño se puede ejecutar, no solo describir.

## Estructura

```
schemas/    contrato Zod del output del paso B
services/   mock de los pasos A, B y C
tests/      tests de contrato e idempotencia
```

## Qué hay acá

- `schemas/payment-step-b-output.schema.ts`: contrato de lo que C necesita de B. Incluye `customer_id`, el campo que se perdió en el incidente.
- `services/pipeline.ts`:
  - `stepB_buggy` reproduce el bug (no propaga `customer_id`).
  - `stepB_fixed` es la versión corregida.
  - `stepC_validateContract` valida el payload contra el schema antes de mandarlo al proveedor.
  - `createPayment` simula el orquestador, con idempotencia por `idempotency_key`.
- `tests/contract.test.ts`: el bug rompe el contrato; el fix lo cumple. En CI, este test bloquearía el merge.
- `tests/idempotency.test.ts`: la misma request, 5 veces, con la misma key, crea un solo pago.

## Cómo correrlo

Desde esta carpeta (`Prueba_Rebill`):

```bash
npm install
npm test
```

Deberían pasar 4 tests (2 de contrato, 2 de idempotencia).

Si Jest no encuentra TypeScript, confirmá que existan `jest.config.js` y `tsconfig.json` (ya están en la raíz).

## Cómo se relaciona con analisis.md

- La sección 5 (harness) habla del contract test y del test de idempotencia. Acá están implementados, a escala mínima.
- La sección 4.2 explica por qué el bug ocurrió en la parte síncrona. `tests/contract.test.ts` reproduce ese escenario.
