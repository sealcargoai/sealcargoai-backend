# Cierre 02-11c — aislamiento de QA (backend)

Versión `2026.11.02-c`. Base: `ad32677` (= producción 3aaa07f en contenido).

| Defecto | Causa raíz | Corrección | Prueba |
|---|---|---|---|
| Un lead real con «demo», «prueba», «testing», «ejemplo» o @example.com quedaba como `[PRUEBA]` | `TEST_RE` sobre nombre, correo y consulta | Una prueba es solo una cuenta de `QA_EMAILS` (`isTestRecord(email)`) | `qa-isolation.test.mjs` 1–2, `recipients.test.mjs` |
| Sin `QA_LEADS_EMAIL`, las pruebas iban a ventas@ | `recipientsFor(test)` caía al buzón comercial | Sin buzón QA válido (`missing` / `invalid` / `overlaps_commercial`) una prueba no se envía: 503 `qa_routing_unavailable` antes de registrar o contar; `/health.qaRouting` informa el estado (sin direcciones); aviso al arrancar | `qa-isolation.test.mjs` 4, `recipients.test.mjs` |
| Un caso registrado antes con otra clasificación conservaba su marca al actualizarse | `registerLead` no recalculaba `test` | Se recalcula en cada solicitud | `qa-isolation.test.mjs` 6 |
| Motivos «Sin verificación (no es proveedor verificado…)», «Calificación 3.8…», detalle «Proveedor verificado» | Textos | Insignias de la plataforma, «Valoración» | `textos-02-11c.test.mjs` |

Configuración necesaria en Railway para probar envíos: `QA_EMAILS` (cuentas de prueba) y `QA_LEADS_EMAIL` (buzón QA que no sea comercial). Verificar `/health` → `"qaRouting":"ok"`.

## 02-11e — aislamiento QA en el envío de informes

Versión `2026.11.02-e`.

| Defecto | Causa raíz | Corrección | Prueba |
|---|---|---|---|
| Un informe pedido por una cuenta QA salía al `recipientEmail` que viniera (cualquier dirección externa) con el buzón QA en BCC | `/api/email/report` solo usaba la marca QA para elegir las copias, nunca para limitar el destinatario | `reportRouting(destinatario, solicitante)`: si el solicitante o el destinatario está en `QA_EMAILS`, la operación es QA y el destinatario debe ser una cuenta de `QA_EMAILS` o el buzón `QA_LEADS_EMAIL`, nunca una dirección comercial. Se decide en la ruta antes de contar los límites diarios y de leer el PDF (403 `qa_recipient_not_allowed`; 503 `qa_routing_unavailable` sin enrutamiento QA) y otra vez en `sendReportToUser` antes de llamar a Resend | `qa-report-isolation.test.mjs` 1, 2, 3, 6-7 |
| `ventas+qa@…` como buzón QA no contaba como comercial (llega a ventas@) | Comparación por texto exacto | Comparación por buzón (`emailKey`: mayúsculas, `+etiqueta`, puntos de Gmail) | 3 |
| Si Resend rechazaba un informe, el reenvío podía ir a ventas | El reenvío usaba las copias comerciales | El reenvío de un informe QA va solo a los destinos QA (`recipientsFor(true)`); un único reenvío, sin reintentos | 5, 5c; 5b (cliente real sin cambio) |
| Un informe al buzón QA llegaba dos veces | El destinatario también iba en BCC | El destinatario no se copia a sí mismo | 2 |

Frontend: el rechazo 403 `qa_recipient_not_allowed` muestra «Envío de prueba bloqueado…» y no descarga el PDF de «no se pudo enviar».

Sigue dependiendo de Railway: `QA_EMAILS` (cuentas QA, también las que reciben informes de prueba) y `QA_LEADS_EMAIL`. `ADMIN_EMAIL`, `ADMIN2_EMAIL` y `QA_NOTIFY_EMAILS` reciben las copias de las pruebas (si alguna es comercial se descarta). El limitador general por IP de `/api/email` (10 por hora) sí cuenta también las solicitudes rechazadas; no se cambió.
