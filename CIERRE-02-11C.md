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

## 02-11f — destinatarios de informes QA por buzón exacto

Versión `2026.11.02-f`.

**Causa raíz.** `qaRecipientAllowed()` autorizaba destinatarios con `emailKey()`, la clave de cuotas e
identificación, que quita `+etiqueta` en cualquier dominio. `qa1+otra-cuenta@dominio` se aceptaba como
`qa1@dominio`, aunque que un alias `+` llegue al buzón base depende de cada dominio y no está garantizado.

**Decisión de normalización.** Se separan dos decisiones:

| Decisión | Regla | Por qué |
|---|---|---|
| Cuotas e identificación de la cuenta que pide (`emailKey`, sin cambios) | Amplia: sin `+etiqueta` en cualquier dominio; puntos solo en Gmail | Un alias no regala búsquedas, y el solicitante `qa1+x@` sigue siendo QA y queda aislado |
| Rechazo de direcciones comerciales (`isCommercial`, sin cambios) | Amplia (`emailKey`) | Todo lo que *pueda* llegar a ventas se rechaza |
| Autorización de un destinatario QA (`mailboxAddress`, nuevo) | Exacta: espacios externos y mayúsculas; puntos y `+` solo en gmail.com / googlemail.com (regla documentada por Google) | Solo se autoriza lo que *seguro* llega a un buzón QA |

Un alias de otro dominio se autoriza únicamente si está escrito tal cual en `QA_EMAILS` (por ejemplo
`qa+informes@dominio`); eso no autoriza la base `qa@dominio` ni otros alias.

**Corrección.** `quotaStore.mailboxAddress()` e `isQaMailbox()`. En `email.js`, `qaRecipientAllowed()` usa
el buzón exacto contra `QA_EMAILS` y `QA_LEADS_EMAIL`. Además, el BCC excluye al destinatario por buzón
exacto. En la ruta, una dirección de más de 254 caracteres se rechaza (400) en vez de recortarse. Antes, el
recorte podía dejar otra dirección válida y el informe de un cliente real salía a esa dirección.

**Pruebas.** `test/qa-recipient-exact.test.mjs` (12):
- tabla de 8 destinatarios autorizados y 25 rechazados: alias `+` no configurado, puntos fuera de Gmail, ventas y sus alias (también listada por error en `QA_EMAILS`), externos, formatos inválidos, listas, nombre visible, salto de línea, cirílico y más de 254 caracteres;
- servidor real con Resend simulado: cero llamadas a Resend y límites diarios intactos ante 75 rechazos; 6 envíos válidos y 6 rechazados en paralelo, de los que exactamente 3 pasan el tope por destinatario; envío a los autorizados solo a destinos QA, buzón QA sin copia a sí mismo, reenvío fallido solo a QA, cliente real por el flujo comercial y logs sin direcciones.

`qa-report-isolation.test.mjs` ahora rechaza `QA1+informe@prueba.test`. Mutaciones comprobadas: regla
amplia de vuelta, sin chequeo de destinatario, sin exclusión comercial y sin chequeo en la ruta. En cada
mutación fallan pruebas.

**Supuesto pendiente.** Si el equipo quiere recibir informes en un alias `+` de un dominio propio, debe
escribir ese alias exacto en `QA_EMAILS` en Railway.

Comportamiento que se mantiene a propósito: un cliente real que envía a un alias de una cuenta QA (`qa1+x@`) cuenta como operación QA y se rechaza. Es la opción segura, porque nunca termina en ventas.

## 02-11g — revisión final de autorización QA

Versión `2026.11.02-g`.

| Defecto | Causa raíz | Corrección | Prueba |
|---|---|---|---|
| `Ka@prueba.test` (con el signo Kelvin) se autorizaba como la cuenta QA `ka@prueba.test`, pero a Resend se le entregaba la dirección original, que es otro buzón | `toLowerCase()` convierte algunas letras no ASCII en ASCII (Kelvin → `k`); la comparación se hacía después de pasar a minúsculas | `mailboxAddress()` rechaza cualquier carácter no ASCII imprimible en la entrada **antes** de pasar a minúsculas: una dirección así nunca se autoriza como destinatario QA | `qa-revision-final.test.mjs` A, «signo Kelvin no llega a Resend» |
| Un alias `+` escrito en `QA_EMAILS` (`juan+qa@empresa`) convertía en cuenta QA a la dirección base (`juan@empresa`) y a todos sus alias. Si `juan@empresa` era un cliente real, su consulta, búsqueda, caso e informe iban al buzón QA en vez de a ventas, y además no tenía límite de búsquedas | `isQa()` comparaba con la clave amplia `emailKey`, que quita el `+` de la entrada configurada | Clasificación por entrada. Una entrada sin `+` cubre sus variantes `+` (la misma persona sigue aislada). Una entrada con `+` fuera de Gmail cubre solo ese alias. En Gmail, alias y base son el mismo buzón (regla de Google) | B, «cliente real… flujo comercial», «límite normal de búsquedas», «alias QA expreso aislado» |

Comprobación de mutaciones (cambiando solo `quotaStore.js`, con las pruebas tal cual):
- con el código 02-11f, 5 de 8 pruebas fallan;
- sin el chequeo ASCII, fallan 2 (A y Kelvin);
- con la clasificación amplia de alias, fallan 3 (B, flujo comercial y límite).

Tamaño del build: el aviso de más de 500 kB viene de `reportExports` (ExcelJS, 1,055 KB) y `costPdf` (jsPDF, 418 KB). Los dos se cargan solo al exportar. El paquete inicial (`index`, 591 KB, 196 KB gzip) incluye el chat porque el formulario de calificación lo usa. Separarlo no mejora la ruta principal y amplía el alcance, así que no se cambió.

## 02-11h — identidad de correo segura (clasificación QA, búsqueda, token, destinatario)

Versión `2026.11.02-h`.

**Causa raíz.**
- `isEmail()` y `normalizeEmail()` aceptaban Unicode, y `toLowerCase()` pliega el signo Kelvin (U+212A) a `k`. Así, `Ka@prueba.test` se volvía `ka@prueba.test`: se clasificaba como esa cuenta QA (el lead iba como `[PRUEBA]` al buzón QA y no a ventas) y compartía su búsqueda y su token de informe. La protección de 02-11g solo cubría `mailboxAddress()`.
- `hasSearched()` y `reportToken()` usaban la clave amplia de cuotas, así que el token de `qa1+x@dominio` servía para `qa1@dominio`.
- La deduplicación de casos también usaba la clave amplia: el caso de un alias QA (`juan+qa@`) se fusionaba con el del cliente `juan@` y lo reclasificaba como prueba.

**Decisiones.**

| Concepto | Regla |
|---|---|
| Formato de correo aceptado | Solo ASCII imprimible (`\x21-\x7e`), comprobado **antes** de pasar a minúsculas. No hay soporte SMTPUTF8/IDN: una dirección con tildes, eñes, homógrafos, ancho completo o caracteres invisibles se rechaza con 400 `email_not_supported` antes de clasificar, registrar, buscar, contar o enviar, y nunca se convierte. Un dominio IDN funciona escrito en punycode (`xn--…`); el navegador lo convierte en los campos `type="email"` |
| Cuotas (`emailKey`) | Sin cambio, amplia: el `+` no regala búsquedas |
| Identidad (`identityKey` = `mailboxAddress`) | Buzón exacto, con la regla documentada de Gmail. Se usa para la búsqueda registrada, el token de informe, el destinatario QA y la deduplicación de casos |
| Clasificación QA (`isQa`) | Igual que 02-11g (entrada sin `+` cubre sus variantes `+`; entrada con `+` solo ese alias), ahora sobre direcciones ASCII |

Enumeración: en este motor, U+212A es el único carácter no ASCII que `toLowerCase()` convierte en ASCII puro. La prueba recorre todo Unicode, así que detecta si cambia.

**Cambios.**
- `quotaStore.js`: `normalizeEmail` acepta solo ASCII; nuevo `identityKey`; `hasSearched`, la búsqueda registrada y `reportToken` usan la identidad.
- `security.js`: `isEmail` acepta solo ASCII; nuevo `unsupportedEmail`.
- `routes/email.js` (lead, quote, report) y `routes/suppliers.js` (search): devuelven 400 `email_not_supported`, sin direcciones en la respuesta.
- `leadStore.js`: la deduplicación usa la identidad.
- Frontend: `utils/emailFormat.ts` da el mensaje claro en el inicio y en «Hablar con SEAL».

**Pruebas.** `test/qa-identidad-segura.test.mjs` (11):
- enumeración Unicode;
- 11 variantes parecidas (Kelvin, cirílico, ancho completo, ZWSP, guion suave, unión invisible, IDN, NFD, İ) en consulta, caso y búsqueda: 400 y cero correos;
- cliente con correo Unicode: error claro, no va a QA; su versión ASCII va a ventas;
- el token de `ka@` no sirve con variantes, alias, puntos ni para otra cuenta QA;
- una cuenta QA no saca informes afuera con mayúsculas, alias, token ajeno ni PDF inválido, y se rechaza antes de límites, PDF y Resend;
- un alias QA y su dirección base son casos distintos;
- un cliente real ASCII va completo por el flujo comercial;
- Gmail y Workspace con reglas distintas;
- logs sin direcciones.

**Mutaciones comprobadas** (ejecutando `qa-identidad-segura` y `qa-revision-final`):

| Se quita | Pruebas que fallan |
|---|---|
| ASCII en `normalizeEmail` | 2 |
| ASCII en `isEmail`/rutas | 7 |
| Las dos (Unicode como antes) | 8 |
| Token y búsqueda con `emailKey` | 3 |
| Deduplicación con `emailKey` | 1 |
| `isQa` solo con `emailKey` | 4 |

**Limitaciones.**
- Los correos con caracteres no ASCII en la parte local no se aceptan; reciben un mensaje claro.
- Tras desplegar, una búsqueda hecha antes con un alias `+` fuera de Gmail necesita repetirse para enviar su informe, porque las marcas guardadas usan la clave anterior.
- Un caso abierto antes con un alias `+` fuera de Gmail no se reconoce como repetición: se abre uno nuevo.
