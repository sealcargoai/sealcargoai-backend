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

## 02-11i — clasificación QA por identidad exacta

Versión `2026.11.02-i`. Base `e535426` (producción `e0b7bf3`).

**Defecto reproducido.** Con `QA_EMAILS=qa1@empresa.test`, una consulta de `qa1+compras@empresa.test` respondía 200, se marcaba `[PRUEBA]` e iba al buzón QA. Su búsqueda y su caso también iban a QA, no tenía límite de búsquedas, y su caso se separaba del flujo comercial.

**Causa raíz.** `isQa()` seguía usando la clave amplia de cuotas (`emailKey`, que quita `+etiqueta` en cualquier dominio): una entrada sin `+` cubría todas sus variantes `+`.

**Decisión.**

| Concepto | Regla |
|---|---|
| Cuotas de búsqueda (`emailKey`) | Amplia, sin cambio: los alias comparten las 3 búsquedas. Las búsquedas de una cuenta QA no cuentan, así que no consumen las de un cliente |
| Clasificación QA (`isQa` = `isQaMailbox`) | Identidad exacta (`identityKey`): solo direcciones escritas en `QA_EMAILS`, con mayúsculas y espacios normalizados. Fuera de Gmail, `qa1@` no cubre `qa1+compras@`. Un alias listado expresamente es QA solo él, sin la base ni otros alias. En gmail.com y googlemail.com los puntos y el `+` son la misma cuenta (regla documentada por Google). No hay regla para Workspace ni para otros dominios |
| Búsqueda registrada, token, destinatario QA y deduplicación | La misma identidad exacta (02-11h) |
| Topes diarios de informes | Un informe real conserva la clave amplia, para que los alias no multipliquen los topes. Un informe QA cuenta por identidad exacta con prefijo `qa:`. **Defecto adicional corregido:** las pruebas de `qa1@` consumían el tope del destinatario real `qa1+compras@` (misma clave) y lo dejaban en 429 |

**Pruebas.** `test/qa-identidad-exacta.test.mjs` (9), con tres servidores reales y Resend simulado:
- el caso reproducido: consulta, búsqueda y caso van a ventas sin `[PRUEBA]`;
- el alias conserva sus límites normales y la cuenta QA no los consume;
- `qa1@` y `qa1+otro@` no comparten búsqueda ni token;
- la cuenta QA no saca informes a externos, a ventas, a alias no listados ni a direcciones invisibles. Se rechaza antes de PDF, Resend y límites;
- el alias no listado envía su informe por el flujo comercial y su tope no lo consume QA;
- Gmail sí une puntos y `+`;
- los casos real y QA no se fusionan;
- un alias listado expresamente es QA solo él, y el reenvío de su informe va solo a QA;
- logs sin direcciones.

Se ajustaron las pruebas anteriores que suponían que `+etiqueta` era QA: `qa-isolation`, `recipients`, `qa-recipient-exact`, `qa-report-isolation`, `qa-revision-final` y `qa-identidad-segura`.

**Comprobación.**

| Código o cambio | Pruebas nuevas que fallan |
|---|---|
| Código publicado `e535426` | 4 (caso reproducido, límites, informe real del alias, fusión de casos) |
| `isQa` con `emailKey` | 5 |
| Token y búsqueda con `emailKey` | 1 |
| Deduplicación con `emailKey` | 1 |
| Topes de informe con la clave amplia también para QA | 1 |

**Limitaciones.**
- Un tester que use `qa1+algo@` sin listarlo en `QA_EMAILS` se trata como cliente real: sus mensajes llegan a ventas, sin `[PRUEBA]`. Cada alias de prueba debe escribirse en `QA_EMAILS`.
- Quien conozca una dirección QA puede buscar sin límite. Es un problema que ya existía y requiere verificar el correo.

## 02-11j — auditoría integral (backend)

Versión `2026.11.02-j`. Pruebas: `test/auditoria-02-11j.test.mjs` (7). Con el código anterior, 6 de 7 fallan; la del token de administración pasa también antes, porque `===` era funcionalmente correcto y el cambio solo endurece la comparación.

| Sev. | Defecto | Corrección |
|---|---|---|
| Alta | Quien supiera el correo y el producto de un cliente recibía, con un envío «repetido», el enlace firmado de **su** caso (chat, presupuesto, precios) y reemplazaba su teléfono, empresa y nombre | Un repetido ya no recibe `caseUrl`: el cliente lo obtuvo al crear el caso. El contacto existente no se reemplaza; los campos vacíos se completan. Los datos distintos se guardan aparte (`proposedContact`) y el correo a SEAL los muestra marcados «no se aplicaron» |
| Media | Un Host `*.up.railway.app` cualquiera (la app de cualquier cliente de Railway) ponía ese sitio en los enlaces de los correos de SEAL | Solo se acepta el host de producción de SEAL; otro host usa la URL de producción |
| Media | Una hoja de tarifas con tipo de cambio 0 o «7,80» (leído como 780), o contenedor de 0 m³, rompía todas las estimaciones | `parseValue`: tipo de cambio entre 1 y 50; m³ de contenedor mayor que 0. Si no cumple, queda el valor por defecto |
| Media | Informes a terceros: el «nombre del destinatario» libre del solicitante iba en el saludo de un correo con la marca de SEAL (vector de phishing) | El nombre solo se usa cuando el informe va al propio buzón del solicitante |
| Media | La página del caso decía «Costo total estimado» para una estimación sin flete | «Costo estimado preliminar (sin flete)» |
| Baja | El correo del caso mostraba «Destino GT» | «Guatemala» |
| Baja | Los registros traían texto del cliente (consulta y material, con saltos de línea inyectables) | Se registran categoría, código o longitud |
| Baja | El token de administración se comparaba con `===` | `timingSafeEqual` |
| Baja | Criterio «Verificación» y «Protección de pago» | «Insignias de la plataforma» y «Protección de pedidos»; el inglés del correo de informe queda «not a quote or a verification» |

**Pendiente, no verificable sin tocar producción:**
- El límite por IP confía en `X-Real-IP`, como dice el comentario sobre el edge de Railway. No lo cambié: si el edge no lo envía, todos compartirían una IP y se bloquearía a los clientes.
- `/api/events` acepta eventos anónimos, así que el embudo se puede inflar.
- El remitente de informes no verifica que el solicitante sea dueño de su correo. El PDF lo genera el navegador, así que también podría ser uno arbitrario.
- Las cuentas QA no tienen límite de búsquedas.

**Revisión independiente (pasada 5), corregido:**
- Un repetido tampoco rellena el teléfono o la empresa que el caso no tenía. Todo dato de contacto nuevo va aparte, y la respuesta trae `contactPending`.
- El aviso a SEAL sale aunque el primer correo haya fallado.
- El token de administración se compara como SHA-256: un token no ASCII del mismo largo daba 500 y revelaba el largo.
- Un entorno de Railway que no es producción enlaza a sí mismo (`RAILWAY_PUBLIC_DOMAIN`).
- Fuera de alcance, ya existía antes: en un repetido, los datos del caso (mensaje, cantidad, presupuesto) se siguen actualizando con lo que llegue. Es la función de actualizar el caso; cambiarlo requiere identificar al cliente.

## 02-11k — prueba de control del correo, casos repetidos, QA y eventos

Versión `2026.11.02-k`. Pruebas nuevas en `test/verificacion-02-11k.test.mjs` (11). Las pruebas anteriores se migraron al nuevo contrato.

| Sev. | Defecto | Corrección |
|---|---|---|
| Crítica | `reportToken` era un HMAC determinista del correo y lo entregaba cualquier búsqueda hecha con ese correo. Quien escribiera el correo de otra persona obtenía la autorización para mandarle informes con la marca de SEAL | La búsqueda ya no entrega token. Para enviar un informe hay que pedir un código de 6 dígitos a ese buzón (`POST /api/email/verify/start`) y confirmarlo (`/verify/confirm`). El servidor genera tokens aleatorios, guarda solo su hash y los liga a la identidad exacta. La autorización del informe (`reportGrant`) dura 30 minutos y sirve una sola vez. El código vence a los 15 minutos y se anula tras 5 intentos fallidos. Hay un tope de códigos por dirección (3/hora) y por IP (10/hora). A las direcciones comerciales de SEAL no se les envía código |
| Alta | Un informe podía ir a un tercero, con un PDF y unos datos generados por el navegador, presentado como documento de SEAL | El informe solo va al buzón verificado del solicitante; otro destinatario recibe 403 `recipient_must_be_requester`. El nombre libre se ignora. El asunto es fijo, el adjunto se llama `SmartTrade_estimacion_preliminar_*.pdf` y el correo dice que el PDF se generó en el navegador con datos del usuario, que SEAL no lo revisó ni lo valida y que es una orientación preliminar, no una cotización ni una verificación |
| Alta | Un envío repetido (mismo correo y producto) modificaba los datos del caso (mensaje, cantidad, presupuesto) y avisaba a SEAL con esos cambios | Sin el token del caso (`caseAuth: ["ID:token"]`, el parámetro `t` del enlace firmado que recibió el cliente al crearlo) no cambia nada: no hay número, ni enlace, ni correo de actualización. Solo si el correo original a SEAL había fallado, se reintenta ese mismo correo sin cambios. Con el token, el titular actualiza sin duplicar. El navegador guarda los tokens de sus casos; desde otro navegador, el cliente actualiza por WhatsApp con su número de caso |
| Alta | Bastaba escribir una dirección QA para quedar sin límite de búsquedas | La exención requiere una sesión verificada de esa misma dirección (`verifiedSession`), también en el limitador por IP. Sin sesión, QA tiene los límites normales y su enrutamiento sigue yendo solo a QA, nunca a ventas |
| Media | `/api/events` contaba como conversión el `solicitud_enviada` enviado por cualquier navegador, sin tope | Los clientes ya no pueden enviar `solicitud_enviada`: el servidor lo registra al crear un caso que no es de prueba. Los demás eventos tienen un tope de 40 por IP al día. La página del embudo aclara que la parte alta es aproximada |
| Baja | Mensajes | Los errores de código, límite y autorización vencida explican qué hacer y no muestran direcciones, tokens ni datos del caso |

**Validación de que las vulnerabilidades no vuelven (mutaciones, cada una hace fallar al menos una prueba):**
- Validar y consumir la autorización eliminados.
- Consumo sin borrar (repetición).
- Chequeo de destinatario quitado.
- Repetido sin token que modifica el caso.
- QA sin sesión que salta límites.
- Conversión aceptada desde el navegador.
- Sin tope por IP.
- La búsqueda vuelve a dar `reportToken`.

**Pendiente o no verificable:**
- El tope por IP confía en `X-Real-IP` del edge de Railway, sin verificar en producción.
- Sesiones, códigos y autorizaciones viven en memoria: un despliegue los invalida, y el cliente pide otro código.
- El PDF se sigue generando en el navegador. Ya no se presenta como validado y solo llega a su autor.
- Cualquiera puede pedir un código para una dirección ajena. Lo recibe solo su dueño y hay un límite de 3 por hora. Con eso, un tercero puede agotar ese cupo o, con 10 códigos equivocados, bloquear la verificación de esa dirección por un día. El dueño puede seguir descargando el PDF o escribir por WhatsApp.
- El correo verificado recibe un PDF hecho por su navegador desde una dirección de SEAL, y podría reenviarlo con la firma DKIM intacta. El texto, el asunto y el nombre del adjunto dicen que no lo valida SEAL. La solución completa es generar el PDF en el servidor; se deja como siguiente paso.
- La respuesta a un repetido sin token (sin número de caso) deja inferir que existe un caso abierto con ese correo y producto. Es baja: no revela datos del caso.
- La entrega real de correos no se comprobó en producción (pruebas con Resend simulado). La verificación depende de que `RESEND_FROM` en producción sea un dominio verificado; no lo cambié ni lo revisé desde aquí.

**Revisión independiente, corregido:**
- Un pedido de código de un tercero ya no anula el del titular (hasta 3 códigos pendientes).
- Los fallos se limitan a 10 por dirección y día.
- Un código que no se pudo enviar no consume el cupo.
- `/quota` acepta la sesión QA en el encabezado `X-Verified-Session` (antes, el formulario detenía a la cuenta QA verificada).
- La respuesta a un repetido sin token es siempre `{success, duplicate, unchanged}`, sin `notified`.
- `/verify/*` tiene su propio limitador, separado del de casos e informes.

**Revisión independiente, sin cambiar:**
- La autorización se consume aunque el envío falle; el cliente pide otro código.
- El tope de 40 eventos por IP al día puede subcontar detrás de NAT de operador.
