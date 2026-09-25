# Payment Gateway Incident: Root Cause, Fix & System Design (Auto prueba)

## 1. Contexto

En Rebill, un cliente intentó pagar y el pago no se aprobó. El sistema es mantenido por una software factory externa que trabaja de forma iterativa: shippea features (A, B, C, D) apoyándose fuertemente en AI, pero no testea sistemáticamente las dependencias entre pasos (F, G, H). El resultado es un pipeline donde cada parte funciona "bien" de forma aislada, pero rompe cuando se integra. Tampoco se prueba de manera colectiva en producción.

Este documento intenta analizar el incidente puntual (citado de memoria en una reunión) y propone tanto la resolución inmediata como el rediseño necesario para que esta clase de falla deje de ocurrir.  

También para demostrar que puedo hacerlo mejor que una software factory.  

P.D: Voy a explicar paso a paso como si fuera un tutorial (para mí misma, afianzo conocimientos mientras escribo)

## 2. Root Cause Analysis

**Síntoma:** el pago del cliente falla en la etapa de aprobación.

**Cadena de causalidad:**

```
Paso A (OK) → Paso B (rompe: deja de enviar un parámetro) → Paso C (recibe payload incompleto) → Proveedor de pago (rechaza: falta un dato requerido)
```

Un cambio reciente en el paso B eliminó un parámetro que el paso C necesitaba para completar el request al proveedor de pago. Al llegar incompleto, el proveedor no puede procesar la transacción y el pago falla.

**Suponemos que las causas son las siguientes:**

- No existe un **contrato explícito** entre los pasos del pipeline. Cada paso asume lo que el anterior le manda, sin validarlo. Cada paso, de manera aislada pasa sus propios tests.
- El código se shippeó **sin tests de contrato ni de integración end-to-end**.
- No hubo **code review** que detectara el impacto de sacar ese parámetro en un paso posterior.
- No hay **observabilidad** que hubiera detectado el problema antes de que un cliente real lo sufriera.

Se arrastra una deuda invisible que no empezó en la falta de parámetro en "B", sino en la fragilidad de que todo está interconectado desde "A".   

Por consiguiente, se busca hacer explícitas las dependencias entre todos los pasos.

## 3. Fix inmediato

Con el cliente esperando, la resolución es:

1. **Reproducir** el fallo con el payload real, corriendo el pipeline paso a paso (A → B → C) para confirmar el parámetro exacto que se pierde. (Se reproduce el fallo en un ambiente controlado)
2. **Rollback o hotfix quirúrgico** en B: revertir el cambio (al código de antes), o si no es posible, restituir el parámetro sin tocar el resto del paso.
3. **Validar contra sandbox** del proveedor antes de asumir que está resuelto.
4. **Reprocesar el pago del cliente afectado usando el mismo** `idempotency_key` (nunca crear un intento de pago nuevo). Si el cliente ya fue cobrado y el sistema no recibió la confirmación, reintentar a ciegas puede duplicar el cobro.
5. **Comunicar proactivamente al cliente.** (En la entrevista se me preguntó por qué yo, y no un rol más técnico. Considero que los roles 100% técnicos no suelen tener tanta fluidez a la hora de comunicarse efectivamente con un cliente y tenerle paciencia; es por eso que es afortunado tener un equilibrio, donde la comunicación esté desde el paso 1, ya que es un servicio.)

Es importante detenernos en el punto 4:  
Idempotencia es diseñar una acción para que, aunque la request se repita, el efecto ocurra una sola vez. (Asignarle un número, por ejemplo el 5, es idempotente, porque no importa cuánto hagas, el resultado es 5. Sumarle un 1, NO es idempotente, porque al pushear el resultado cambia cada vez).  

Teniendo esto en cuenta, "cobrar X cantidad" (véase $5000) NO ES NATURALMENTE IDEMPOTENTE (si se ejecuta dos veces, la cantidad se duplica).  

Entonces ¿Por qué idempotencia?  
El objetivo es forzar artificialmente a que se comporte como si lo fuera. En este caso "cobrar $5000 asociado a este intento específico, sin importar cuántas veces se mande el mismo request".  

Entonces ¿Qué es el `idempotency_key`?  
Es un identificador único que se tiene que generar en el sistema para un intento de pago específico (un UUID, por ej) y se lo envía al proveedor junto con el request de cobro.  

**ESTO ES IMPORTANTE**: El proveedor guarda ese key asociado al resultado de la operación. Si le llega otro request con el mismo key, no vuelve a cobrar, y devuelve el resultado que ya tenía guardado en el primer intento.   

Pero si el rechazo fue claro ¿Por qué se usaría?   

1. Por buenas prácticas: Se supone que no sabés de antemano si el escenario es "rechazo limpio" o "timeout" hasta que se investiga. Se usa por default más que nada para no estar discriminando caso por caso.
2. El mismo intento de pago (mismo `payment_id`/`idempotency_key`) evita que, si el cliente reintenta reiteradamente mientras se investiga, se terminen generados múltiples intentos duplicados en el sistema.

**4. Diseño de sistema**

El problema de fondo de un payment gateway no es procesar el pago, sino qué hacer cuando el sistema no sabe con certeza qué pasó (el servidor cae, la respuesta se pierde, el webhook llega duplicado o tarde).

![Payment Gateway HLD](diagrams/payment-gateway-hld.png)

### 4.1 Principios de diseño

**Idempotencia desde el origen.** Cada pago tiene un `payment_id` propio y acepta un `idempotency_key` del cliente. Si la misma request llega N veces, se crea un único intento de pago. Esto es lo que permite reintentar con seguridad en el punto 4 del fix inmediato. (Lo explicado más a detalle más arriba).

**El cliente nunca es la fuente de verdad.** El estado real del pago vive en una máquina de estados del lado del servidor, alimentada por respuestas verificadas del proveedor y webhooks. No por lo que el cliente dice que pasó. No lo sabe con certeza, y no tiene por qué entenderlo.

```
CREATED → PROCESSING → SUCCESS
                    ↘
                      FAILED
PROCESSING → UNKNOWN   (el servidor cae o pierde la respuesta antes de saber el resultado)
```

El estado `UNKNOWN` es intencional: no todo fallo tiene una respuesta inmediata, y el sistema tiene que poder representar "no sé qué pasó" sin asumir éxito ni fracaso.

**Flujo síncrono mínimo, todo lo demás asíncrono.** La única parte que bloquea al cliente es crear el pago y disparar el request al proveedor. Confirmar el resultado, actualizar métricas, notificar, reconciliar; todo eso pasa por eventos (Kafka → workers), fuera del camino crítico. Es el mismo principio que separar una acción de sus consecuencias: lo mínimo indispensable para responder rápido, el resto reacciona a lo que ya pasó.  

Pongamos un ejemplo más simple. Supongamos que nos registramos en una página:  

Guardar usuario → Mandar email → Registrar en analytics → Avisar por Slack → recién ahí responder.  

El usuario espera toda esa cadena. Si el servicio tarda 5 segundos o se cuelga, el usuario espera esos 5 segundos o nunca recibe respuesta, a pesar de que figure en nuestra base de datos.  

La pregunta es ¿Qué es lo mínimo que debe modificarse para decir que todo salió bien? En el signup es guardar el usuario. Todos los pasos siguientes suceden como consecuencia de ese paso A.  

Entonces hacés lo mínimo indispensable de forma *síncrona* (esperando) y todo lo demás se dispara en un evento posterior sin que el usuario espere.  

Guardar usuario → responder "listo" al usuario (rápido)

```
            ↘

              evento "UserRegistered" → un worker aparte manda el email, otro registra analytics, otro avisa por Slack.  
```

**Si lo llevamos al caso de pagos:** Lo mínimo indispensable para decirle al cliente "procesando pago" es crear el registro del mismo y mandárselo al proveedor.  Eso es síncrono, ya que el cliente depende de eso. Todo lo demás se dispara a su tiempo.  

Payment Service → publica "PaymentCreated" en Kafka

```
                            ↓

    ┌───────────┬───────────┼───────────┐
```

   Notificaciones  Analytics  Reconciliación  Webhook processor

   (lo lee cuando  (lo lee    (lo lee cuando   (lo lee cuando

```
puede)          cuando     puede)           puede)

                puede)
```

**Webhooks tratados como eventos.** Los proveedores entregan con semántica *at-least-once* (pueden mandar el mismo webhook más de una vez, o fuera de orden.) El webhook service verifica firma, deduplica, y recién ahí publica el evento. El procesamiento downstream tiene que ser idempotente por diseño, no por parche.  

*Pero ¿Qué es un webhook?* Es la forma en la que un proveedor de pago (Rebill) me avisa, de forma proactiva, que algo pasó del otro lado. En vez de estar haciendo polling (preguntar todo el tiempo si ya se cobró), Rebill manda un request a una URL mía diciendo "X pago se aprobó"  

La *semántica at-least-once* significa que el proveedor me garantiza que el webhook me va a llegar *al menos una vez*, pero no garantiza que llegue *una única vez.*  

Esto es importante si el sistema, al recibir un webhook de "pago aprobado", hace algo como "sumale $5000 al balance del usuario" sin ningún control, y ese webhook llega duplicadose sumaron $10000 por error.  

**Entonces:**  
**1. El webhook service verifica firma, deduplica, y recién ahí publica el evento:** Antes de hacer nada con el contenido del webhook, primero confirma que es legítimo (la firma prueba que realmente vino del proveedor y no de alguien haciéndose pasar por él) y chequea si ya procesó ese mismo webhook antes (por ejemplo, guardando el ID del evento que el proveedor le manda). De ser así, lo descarta. Si es nuevo, lo publica como evento hacia Kafka para que haga todo lo anterior mencionado.

2 **.Aunque el webhook service deduplique, no podés depender 100% de esa única capa**. La forma robusta de construirlo es que **cada parte que procesa ese evento también sea segura ante repetición,** usando el ejemplo de idempotencia anterior: "actualizar el estado del pago a SUCCESS". Es por diseño, no parchearlo al final.

**Reconciliación como red de seguridad permanente.** Un job periódico compara el estado interno contra el proveedor y el banco, y repara discrepancias: cliente cobrado pero marcado como fallido, webhook perdido, reembolso externo no reflejado internamente. Ningún sistema de pagos evita el 100% de los casos `UNKNOWN` con testing. Entonces, la reconciliación es lo que cierra ese margen en producción.  

Con todo lo visto anteriormente, el sistema es mucho más robusto. Pero sigue habiendo casos que no se pueden predecir. Ej: El servidor se cae en el momento en que se iba a guardar una confirmación de pago.  

Esos tipos de casos son los, hasta ahora llamados, UNKNOWN.  

**¿Entonces, reconciliación qué es?** Es un proceso que corre solo (cada hora, cada día, queda a discreción) y compara la versión de los hechos del servidor con la versión del proveedor y del banco, y busca diferencias.  

Tu base de datos dice: "pago X = FAILED"

El proveedor dice:      "pago X = SUCCESS, cobrado"  

Si no coinciden, hay un problema, porque el cliente fue cobrado pero no aparece en el sistema. Entonces la reconciliación detecta eso y lo corrige.

**¿Por qué red de seguridad?**  Todo el sistema armado hasta ahora **intenta evitar** que el problema pase. La **reconciliación** asume por defecto que **algo se va a escapar.**

### 4.2 Por qué este incidente puntual encaja acá

El bug original ocurrió en la parte síncrona del flujo (A→B→C), que es justamente la que tiene que ser mínima y con contrato estricto. No hay red de seguridad de "ya lo reintento después". Por eso el estándar de calidad en esa parte tiene que ser más alto que en el resto del sistema. Si hubiera existido validación de schema en el API Gateway o entre B y C, el payload incompleto se hubiera rechazado ahí, antes de llegar al proveedor.

## 5. Por qué esto no vuelve a pasar: el harness de CI/CD

La causa de fondo es "shippean todo con AI, mal hecho,y rompen cosas" 

Propongo que se resuelva con un harness (siendo este un conjunto de herramientas y procesos que rodean el código para probarlo, validarlo o ejecutarlo de forma controlada) que hace explícito y automático lo que hoy depende de que alguien se acuerde.

**Qué valida el harness en cada cambio que toca el pipeline de pagos:**

1. **Contratos entre pasos.** Schema (Zod / Pydantic / JSON Schema) de input y output de cada paso. Si un PR (pull request) modifica B y el output deja de cumplir lo que C requiere, el build falla ahí. Antes de merge, no en producción con un cliente real.

```
   Ejemplo de cómo se vería JSON Schema:

{
```

```
  "type": "object",
```

```
  "required": ["payment_id", "amount", "currency", "customer_id"],
```

```
  "properties": {
```

```
    "payment_id": { "type": "string" },
```

```
    "amount": { "type": "number" },
```

```
    "currency": { "type": "string" },
```

```
    "customer_id": { "type": "string" }
```

```
  }
```

```
}
```

Si, por ej, `customer_id` es el parámetro que se perdió en el bug original, este schema dice "esto es obligatorio"

- **Zod**: una librería de JavaScript/TypeScript. Se usa si el pipeline está escrito en ese lenguaje.
- **Pydantic**: lo mismo pero para Python
- **JSON Schema**: más universal.

Se propone agregar a ese pull request, como parte del build automático, un test que toma el schema de B y lo compara **contra lo que C espera recibir.** Si se modifica B y, en este caso, ya no incluye `customer_id` , el test falla, y el sistema de CI "le dice" a quien modificó que no puede mergearse porque rompe el contrato con C, ANTES de que el código llegue a producción.

1. **Test end-to-end contra sandbox real del proveedor.** No mockear el proveedor de pago. Correr el flujo completo (create → process → webhook) contra casos conocidos: pago exitoso, rechazado, timeout simulado, webhook duplicado.
2. **Idempotencia como test explícito.** Mandar la misma request N veces con el mismo `idempotency_key` y verificar que se creó un solo intento de pago. Barato de escribir, de los que más incidentes evitan.
3. **Gate diferenciado para paths críticos.** Si el diff toca `payment-service/`, `webhook/`, o equivalentes, el harness exige contract tests + integration tests en verde **y** review humano obligatorio, sin excepción de auto-merge. El código generado con AI puede proponer, pero en el path de dinero no aprueba solo.
4. **Reconciliación en runtime, y no solo en CI.** El job de reconciliación (sección 4.1) corre continuamente en producción como chequeo permanente, cubriendo lo que ningún test de pre-merge puede anticipar.

**Flujo resultante:**

```
PR → contract tests → integration test (sandbox) → [si toca paths críticos: review humano obligatorio] → merge → deploy canario → reconciliación continua en producción
```



## 6. Trade-offs

Contract testing e integration testing contra sandbox agregan fricción a cada cambio: más tiempo de CI, más mantenimiento de fixtures. Tiene sentido pagarlo en el pipeline de pagos, donde el costo de un fallo es dinero real y confianza del cliente. No necesariamente en el resto del producto, donde puede ser over-engineering.

De la misma forma, exigir review humano obligatorio en paths críticos ralentiza el ciclo de deploy en esa zona puntual. Es un trade-off consciente: velocidad de shipping vs. blast radius de un error en dinero de terceros. En pagos, gana el segundo.

## 7. Idea central

En este README intenté entender el diseño de un sistema de pagos, asumiendo que no se parte de la premisa de  "request exitoso = pago exitoso", sino en base a la pregunta de *"¿qué puede fallar y por qué, cómo lo evito?"* .
