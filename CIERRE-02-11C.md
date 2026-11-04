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

## 02-11l — almacén de verificación persistente, abuso de códigos y remitente

Versión `2026.11.03-l`. Pruebas nuevas en `test/verificacion-02-11l.test.mjs` (16). Con el código de 02-11k fallan 10 de las 11 originales. La única que pasa es la de privacidad, que ya se cumplía antes.

| Sev. | Causa raíz | Cambio |
|---|---|---|
| Alta | Los códigos, las sesiones y las autorizaciones vivían en la memoria del proceso. Un reinicio o despliegue los perdía, y dos instancias no se veían entre sí. Con dos procesos, una autorización podía usarse una vez en cada uno. | Se guardan en `DATA_DIR/verify.json` (el volumen de Railway) o en `VERIFY_DATA_DIR` si se define. Cada operación: (1) toma un bloqueo exclusivo (`wx` con nonce; uno abandonado por más de 2 s se toma por `rename` atómico, y solo se libera el bloqueo propio); (2) lee y modifica; (3) escribe con `fsync`; (4) reemplaza con `rename`. `consumeGrant` verifica y borra dentro del mismo bloqueo. Una lectura que no cambia nada no reescribe el archivo. |
| Alta | Si el almacén fallaba, no había un comportamiento definido. | Falla cerrado: `VerifyStoreError` → 503 `verify_unavailable` («no se envió nada»). Nunca se concede ni se envía. Las búsquedas siguen funcionando, pero una sesión QA no se reconoce, así que aplican los límites normales. Un archivo dañado (no es JSON) se aparta y el almacén arranca vacío: solo se pierden credenciales y contadores. |
| Media | En el archivo podía quedar algo en claro. | Códigos, tokens, direcciones e IP se guardan como HMAC-SHA256, y el archivo tiene permisos 0600. La clave sale de `VERIFY_SECRET`; si no existe, se deriva del secreto de firma (`REPORT_SECRET` o `DATA_DIR/report-secret`, que ahora se crea con `wx`, así dos procesos no generan secretos distintos). `/health` → `verifyStore`: `persistent`, `persistent-ephemeral-key` (la clave no sobrevive a un reinicio) o `memory`. |
| Media | Un tercero podía agotar el cupo de una dirección, y sus intentos fallidos anulaban el código del titular. | Límites: (1) por dirección e IP, 3 por hora, con espera progresiva de 0, 30 y 60 s (`Retry-After`); (2) por dirección, 6 por hora; (3) por IP, 10 por hora; (4) global, 300 por hora; (5) como máximo 30 000 claves registradas. Un código nuevo no anula los anteriores (todos valen 15 min). Los fallos se cuentan por dirección e IP: 5 por hora bloquean esa IP, no al titular. Después de 15 fallos al día en una dirección, solo se acepta un código pedido desde la misma IP que lo confirma: el titular entra y una fuerza bruta desde muchas IP no. Las direcciones de ventas de SEAL pasan por los mismos límites, con una demora similar y sin código guardado. |
| Media | No había forma de saber, sin enviar un correo, si el remitente funcionaría. | `/health` → `emailSender`. `from` es `custom` o `resend-test-sender`. `domain` es el estado que devuelve `GET https://api.resend.com/domains` para el dominio exacto del remitente: `verified`, `pending`, `failed`, `not_found`, `no_access` (la clave no puede leer dominios) o `unknown`. Es solo lectura, no envía correo y no expone la dirección, el dominio ni la clave. |

**Evidencia:**
- `npm test`: 167 de 167.
- Concurrencia real: 8 procesos consumen la misma autorización y solo 1 lo logra; 12 procesos piden códigos y nunca salen más de 6. Dos servidores comparten carpeta: el código se pide en A y se confirma en B; un informe enviado a A y B a la vez sale una sola vez.
- Mutaciones; cada una hace fallar al menos una prueba:
  - quitar el bloqueo;
  - consumir en dos pasos;
  - que los fallos anulen el código;
  - tope diario sin excepción;
  - quitar la espera progresiva;
  - leer un archivo ilegible como vacío;
  - aceptar tras el tope un código de otra IP.

**Limitaciones:**
- El archivo con bloqueo sirve para procesos que comparten el volumen (en Railway, una sola réplica con el volumen montado). Para varias réplicas sin volumen compartido hace falta un almacén de red (Redis o Postgres con transacción); hoy no existe en el proyecto.
- Mientras se espera el bloqueo, el proceso queda detenido como máximo 1 s; si no lo obtiene, responde 503.
- Un tercero con muchas IP todavía puede llenar el cupo por hora de una dirección y mandarle hasta 6 códigos por hora. El titular conserva los códigos que ya recibió y puede volver a pedir uno después.
- Los topes diarios de informes (`sentTo`/`sentBy`) siguen en memoria por proceso. Esto viene de antes.
- Si el envío falla después de consumir la autorización, el cliente tiene que pedir otro código.
- La entrega real de correos no se probó; todas las pruebas usan Resend simulado.

## 02-11m — persistencia en Railway verificada, abuso del flujo de códigos y topes diarios de informes

Versión `2026.11.03-m`. Pruebas nuevas en `test/verificacion-02-11m.test.mjs` (12). Las del bloque original fallan 6 de 7 con el código de 02-11l (la que pasa es la de privacidad). También se ajustaron las pruebas de 02-11k/02-11l que fijaban la política anterior.

### 1. Persistencia (configuración real, revisada en Railway en modo solo lectura el 03-11-2026)

- **Proyecto y servicio:** proyecto `proud-celebration`, entorno `production`, servicio `sealcargoai-backend`.
- **Volumen:** `sealcargoai-backend-volume`, de 5 GB, montado en **`/data`**.
- **Variables del servicio (23):**
  - `DATA_DIR` = **`/data`**. Mostré solo ese valor, porque es una ruta; los demás quedaron ocultos.
  - No existen `VERIFY_DATA_DIR`, `VERIFY_SECRET` ni `REPORT_SECRET`.
  - En consecuencia, la clave de los hashes se deriva del archivo `report-secret`, guardado en `/data`, dentro del volumen. Eso hace que sobreviva a reinicios y despliegues.
- **Réplicas:** Railway dice: «Replicas are not available for attached volumes». El servicio corre como **una sola instancia**.
  - El almacén de archivo con bloqueo cubre esa instancia y también la superposición entre el proceso que sale y el que entra en un despliegue.
  - Escalar a varias réplicas exigiría un almacén de red (Redis o Postgres con transacciones). Hoy no existe en el proyecto y tendría costo, así que no lo agregué.
- **Evidencia en tiempo de ejecución:** `/health` → `storage`:
  - `dataDir` / `verifyDir`: `on-volume`, `not-on-volume`, `no-volume-attached` o `unset`. Se calcula comparando con `RAILWAY_VOLUME_MOUNT_PATH`, que Railway define al adjuntar un volumen.
  - `verifyKey`: `env`, `volume-file`, `file-not-on-volume` o `ephemeral`.
  - No expone rutas ni valores.
- **No cambié nada en Railway:** ni variables, ni volumen, ni datos.

### 2. Remitente de Resend

- `RESEND_FROM` usa el dominio **`seal-ai.sealcargo.com.gt`**. Vi solo el dominio; la dirección completa no la copié a ningún lado.
- `/health` sigue diciendo `domain: "no_access"`: la clave de producción no puede leer `/domains`, probablemente porque es de solo envío.
- El panel de Resend no estaba abierto en el navegador. No inicié sesión, porque eso requiere credenciales.
- **DNS público, consultado con dns.google, solo lectura:**
  - DKIM: `resend._domainkey.seal-ai.sealcargo.com.gt` publica la clave (`p=…`).
  - Envío: `send.seal-ai.sealcargo.com.gt` tiene MX `feedback-smtp.us-east-1.amazonses.com` y SPF `v=spf1 include:amazonses.com ~all`.
  - DMARC: `_dmarc.sealcargo.com.gt` = `v=DMARC1; p=none;`, que hereda el subdominio.
- **Conclusión:** los registros que Resend pide para ese dominio están publicados. El estado «Verified» dentro de Resend y la entrega real **no están verificados**.
- **Verificación controlada pendiente (manual):**
  1. Abrir Resend → Domains y confirmar que el dominio aparece «Verified».
  2. Enviar un único informe de prueba a un buzón propio del equipo y revisar que llegue, y si cae en spam.
  - Si se quiere que `/health` lo muestre, crear una clave de Resend con permiso de lectura de dominios y mínimo privilegio, y configurarla con autorización.

### 3. Abuso del flujo de códigos

- **Causa raíz** (revisión independiente, hallazgo ALTO):
  - El tope de 30 códigos por día y dirección, junto con el bloqueo por dirección tras 15 fallos al día y la regla de «solo códigos pedidos desde esta IP», permitían a un tercero dejar al titular **sin código utilizable** de forma sostenida.
  - Bastaban unos 30 pedidos y 15 fallos al día.
  - Esas medidas existían solo porque un código de 6 dígitos es adivinable.
- **Cambio:**
  - Códigos de **8 caracteres** de un alfabeto de 32 símbolos (sin I, O, 0 ni 1), unos 40 bits. Se aceptan con minúsculas, espacios o guion.
  - Se eliminaron el bloqueo por dirección, el tope diario por dirección y la restricción por IP. Así, **cualquier código que llegue al buzón del titular le sirve desde cualquier conexión**.
  - Se mantienen:
    - 5 fallos por hora por dirección e IP, que bloquean solo esa IP;
    - 3 por hora por dirección e IP, con espera de 0, 30 y 60 s;
    - 6 por hora por dirección, más un cupo reservado de hasta 12 por hora: cada conexión con 0 o 1 pedido en la hora y sin bloqueo puede pedir;
    - 10 por hora por IP y 300 por hora en total;
    - los códigos anteriores siguen valiendo durante sus 15 minutos;
    - la misma respuesta para todas las direcciones.
  - Una espera de más de 5 minutos se redondea a múltiplos de 5 minutos, para no revelar cuándo pidieron otros.
- **Fuerza bruta:** 5 intentos por IP y hora contra 12 códigos vigentes, sobre unos 1.1·10¹² combinaciones. Con 10 000 IPs sostenidas durante un año, la probabilidad de acertar sigue por debajo de 10⁻³. **Esta cifra estaba subestimada: la cota correcta para 8 caracteres era ~4.8·10⁻³ (0.48 %). Se corrigió en 02-11n.**
- **Volumen máximo que un tercero puede mandar a una dirección:** 12 por hora, y solo con al menos 4 IPs. No hay tope diario, porque ese tope era la palanca de bloqueo; queda documentado.

### 4. Topes diarios de informes

- **Causa raíz:** `sentTo`/`sentBy` vivían en la memoria de cada proceso. Un reinicio los ponía en cero.
- **Cambio:**
  - Ahora se guardan en el almacén compartido, como hash, con una ventana de 24 h.
  - `consumeGrantAndCount` usa la autorización y cuenta el informe **en una sola operación atómica**.
  - Al llegar al tope responde 429 `report_limit` y la autorización **no se gasta**.
  - `reportCapOk` queda como aviso temprano, antes de leer el PDF.
- **Sin cambiar, a propósito:** un envío que falla después de contarse sigue gastando el cupo y la autorización. Devolverlos ante un timeout ambiguo podría duplicar el envío.

### Comandos y resultados

- `npm ci && npm test`: **178 de 178**.
- Concurrencia real:
  - 8 procesos con autorizaciones distintas → exactamente 3 informes.
  - 6 informes a la vez contra 2 servidores → 3 aceptados y 3 rechazados con 429.
  - Reinicio del servidor → el tope se mantiene.
- Mutaciones (cada una hace fallar al menos una prueba):
  - quitar el cupo reservado;
  - no mirar el bloqueo de la IP;
  - que `cancel` no devuelva el cupo;
  - un solo pedido reservado;
  - quitar el chequeo o el conteo atómico del tope de informes.

### Limitaciones

- Una sola instancia, por diseño de Railway con volumen.
- La entrega real y el estado «Verified» en Resend no se verificaron.
- `/health` es público y muestra estados de configuración, sin valores.
- Un tercero con muchas IPs puede mandar hasta 12 códigos por hora a una dirección: es un costo de no bloquear al titular.


## 02-11n — corrección del cálculo de riesgo, código de 10 caracteres y versión estable candidata

Versión `2026.11.03-n` (backend y frontend). Base: la candidata `fix-02-11m`.

### Cálculo de riesgo de los códigos (corregido)

**La cifra de 02-11m estaba subestimada.** Decía que, con 10 000 IP durante un año, el riesgo quedaba por debajo de 10⁻³. No se contó que un atacante puede concentrar todos sus intentos mientras están vigentes los 12 códigos que él mismo pide. Con 8 caracteres, la cota real era 4.77·10⁻³ (0.48 %).

**Modelo** (`scripts/riesgo-codigos.mjs`, que lee los parámetros reales de `verifyStore.js`):

| Símbolo | Significado | Valor |
|---|---|---|
| N | Combinaciones posibles: alfabeto^longitud | 32¹⁰ ≈ 1.126·10¹⁵ (antes 32⁸ ≈ 1.100·10¹²) |
| V | Códigos vigentes a la vez para un buzón | ≤ 12, el tope por hora y dirección. El atacante los pide juntos y valen 15 min. |
| g | Intentos fallidos por IP y dirección por hora | 5. Una IP puede gastarlos dentro de esos 15 min. |
| K | Conexiones distintas del atacante | IPv4, o un /64 en IPv6 |
| H | Horas de ataque sostenido | 8 760 (un año) |

Fórmulas, con G = g·K·H intentos en total:

- **Cota conservadora** (atacante óptimo, que concentra todo): P ≤ 1 − (1 − V/N)^G ≈ G·V/N
- **Probabilidad esperada** (los pedidos repartidos en la hora): V_prom = 12 · 15/60 = 3, y P ≈ G·V_prom/N

**Resultados para 1 año con 10 caracteres** (tabla generada por el script; la prueba `test/riesgo-codigos.test.mjs` exige que coincida):

| K (IP) | cota conservadora | esperada |
|---|---|---|
| 1,000 | 4.67e-7 | 1.17e-7 |
| 10,000 | 4.67e-6 | 1.17e-6 |
| 100,000 | 4.67e-5 | 1.17e-5 |

Con 8 caracteres, los mismos casos daban 4.78e-4, 4.77e-3 y 4.67e-2: con 100 000 IP no se alcanzaba el objetivo de 10⁻⁴.

**Cambio aplicado:**
- Código de **10 caracteres** (unos 50 bits), mostrado como `ABCDE-FGHJK`.
- No se agregó ningún bloqueo por dirección, así que el titular no queda fuera.
- Todo lo demás se mantiene: 15 minutos de vigencia, códigos anteriores válidos, 5 fallos por hora que bloquean solo esa IP, y 12 códigos por hora por dirección.

**No son garantías:** estas cifras salen de un modelo. No cubren fallas de implementación, el robo del buzón, ni un atacante con más de 100 000 conexiones (por ejemplo, una red de bots muy grande o muchos /48 de IPv6).

**Prueba de regresión** (`test/riesgo-codigos.test.mjs`):
- La cota con los parámetros reales debe ser < 10⁻⁴ para 100 000 IP en un año.
- Las cifras de esta tabla deben coincidir con el cálculo.
- La cifra de 8 caracteres se considera subestimada.
- Con el código de 8 caracteres, la primera prueba falla.

### Persistencia en Railway (revisada otra vez el 03-11-2026, solo lectura)

- **Volumen:** `sealcargoai-backend-volume`, montado en `/data`. Se leyó en Volume → Settings → Mount path.
- **Variables del servicio (23):**
  - `DATA_DIR` = `/data`. Revelé solo ese valor, que es una ruta, y volví a ocultarlo.
  - No existen `VERIFY_DATA_DIR`, `VERIFY_SECRET`, `REPORT_SECRET` ni `EMAIL_DRY_RUN`.
- **Réplicas:** Railway dice «Replicas are not available for attached volumes»; el servicio corre en una sola instancia.
- **Clave de los hashes:** sale del archivo `report-secret` en `DATA_DIR`, es decir, en `/data`, dentro del volumen.
  - La producción actual (02-11l) reporta `verifyStore: "persistent"`. Eso solo ocurre si el secreto se leyó o creó en el volumen.
  - El campo `/health.storage`, que muestra `on-volume` y el origen de la clave, llega con esta versión. **En producción todavía no se puede ver** hasta publicar.

### Resend (solo lectura)

- **Dominio del remitente:** `seal-ai.sealcargo.com.gt`. La dirección completa no se copia.
- **DNS público** (dns.google):
  - DKIM `resend._domainkey`: presente (`p=…`).
  - `send.`: SPF `v=spf1 include:amazonses.com ~all` y MX `feedback-smtp.us-east-1.amazonses.com`.
  - DMARC del dominio principal: `p=none`.
- **Panel de Resend:** no hay sesión iniciada y no se inició ninguna, así que el estado «Verified» no se vio.
- `/health.emailSender.domain = "no_access"` solo indica que la clave de producción no puede leer `/domains`. **No prueba que el envío falle, ni acredita que el dominio esté verificado.**
- **La entrega real no se verificó:** no se envió ningún correo.

### Otros ajustes

- Si un correo ya recibió los 3 informes del día, la pantalla ahora lo dice así en ES/EN («máximo de informes de hoy (3 en 24 horas)») y descarga el PDF. Antes decía «no pudimos enviarlo desde aquí».

### Riesgo residual por volumen de códigos

- **Por buzón:** un tercero con 4 o más IP puede hacer que un mismo buzón reciba hasta 12 códigos por hora (288 por día). Para el titular es molestia o spam, pero no le impide verificar.
- **Global:** el tope de 300 códigos por hora protege la reputación del remitente. A cambio, un atacante con unas 30 IP puede agotarlo y dejar la verificación sin servicio para todos durante una hora.
- **Proveedor de correo:** demasiados rebotes o quejas pueden llevar a Resend o a Gmail a limitar el remitente. Se recomienda vigilar el panel de Resend (rebotes y quejas).
- Para reducirlo más haría falta un CAPTCHA o un servicio anti-abuso. Requiere credenciales nuevas y posiblemente costo; no se agregó.

## 02-11o — agotamiento global de códigos: cupo por red, desafío adaptativo, reserva y recuperación del titular

Versión `2026.11.04-o`. Pruebas nuevas en `test/verificacion-02-11o.test.mjs` (12) y en `test/riesgo-codigos.test.mjs` (1 más).

### Causa raíz

El tope global de 300 códigos por hora protegía la reputación del remitente, pero tenía cuatro problemas:

- **Era fácil de agotar.** Bastaban 30 IP a 10 por hora, aunque fueran de una misma red. Mientras durara, nadie recibía código.
- **Las direcciones de ventas de SEAL gastaban cupo** aunque a ellas nunca se les envía nada.
- **No había desafío** que encareciera los pedidos automatizados.
- **No había manera de pedir otro informe sin un código nuevo.**

### Cambios

| Control | Detalle |
|---|---|
| Direcciones de ventas | Pasan por los mismos límites por dirección e IP, con la misma respuesta y una demora parecida. No gastan cupo global ni de red, y no se guarda ningún código para ellas. |
| Cupo por red | Una red (IPv4 /24, IPv6 /48) puede usar como máximo 30 de los 300 códigos por hora. |
| Desafío adaptativo (prueba de trabajo) | Desde el 50 % del cupo de la hora, cada pedido debe traer resuelto un desafío firmado por el servidor: SHA-256(desafío:nonce) con 16 ceros iniciales, y 18 desde el 80 %. El desafío queda ligado a la dirección y a la conexión, vale 5 minutos y sirve una sola vez. Aplica también a las direcciones de ventas, para que la respuesta sea idéntica. Sin servicios externos ni credenciales. |
| Reserva | Agotados los 300, quedan 60 códigos por hora para redes que no pidieron nada en esa hora: uno por red, con el desafío de 18 bits. Techo para el remitente: 360 por hora. |
| Recuperación del titular | Con su sesión verificada de las últimas 12 h, el titular obtiene otra autorización de informe sin que se le mande un código nuevo (`POST /api/email/verify/renew`), hasta 10 por día. Además, los códigos que ya recibió siguen valiendo 15 minutos, y nadie puede anularlos. |
| Envío fallido | Devuelve todos los cupos, incluidos el de red y el global o de reserva. |

### Costo de agotar el cupo de una hora (parámetros reales; `node scripts/riesgo-codigos.mjs`)

- Antes (02-11n): 300 códigos con al menos 30 IP, aunque fueran de una sola red, y sin trabajo de cómputo.
- Ahora: Agotar el cupo de una hora: 360 códigos, ≥70 redes, ≥90 IP, ~3.74e+7 hashes SHA-256 de desafío

**Lectura honesta:**
- Unos 3.7·10⁷ hashes son segundos de CPU para un atacante con código nativo. El desafío detiene a los bots que no lo resuelven y encarece el ataque, pero no impide un agotamiento organizado con 70 redes o más.
- En ese caso, quien ya verificó su correo en las últimas 12 h sigue pudiendo enviar su informe, y los códigos ya recibidos siguen sirviendo.
- Una persona nueva tendría que esperar a que se libere cupo.
- Para cerrar del todo ese escenario haría falta un servicio anti-abuso externo (por ejemplo Cloudflare Turnstile o hCaptcha). Requiere una clave del sitio y una secreta, y tal vez costo, así que no se agregó. Para integrarlo harían falta: una variable con la clave secreta en Railway, la clave del sitio en Vercel y la verificación del token en `/verify/start` antes del desafío.

El riesgo de adivinar un código no cambia: la tabla de 02-11n sigue siendo válida, porque el tope de 12 códigos por hora y dirección es el mismo.

### Modelo de amenaza (resumen)

| Actor | Lo que puede hacer | Lo que ya no puede |
|---|---|---|
| Bot que no resuelve el desafío | Hasta 150 códigos por hora (el primer 50 %) | Gastar cupo después del 50 % |
| Red única | 30 códigos por hora | Agotar el cupo global |
| Atacante distribuido con cómputo nativo | Agotar 360 por hora con ≥70 redes | Anular códigos ya recibidos o la sesión del titular |
| Tercero que conoce un correo | Mandarle hasta 12 códigos por hora (molestia) | Adivinar el código, gastar la autorización del titular o sus topes de informes |

### Evidencia

- `npm ci && npm test`: **193 de 193**, 0 fallas, 0 omitidas.
- En 1 de unas 8 corridas completas falló de forma intermitente la prueba 5 de 02-11k, porque contaba todos los correos del servidor. Un aviso sin esperar (de otra prueba) podía llegar tarde bajo carga. Se corrigió contando solo los correos de ese caso. Después de corregirla, la suite completa pasó en 2 corridas seguidas.
- Desafío en un navegador real (Chromium local, sin GPU): uno de 16 bits se resolvió en ~0.8 s. El de 18 bits debería tardar unas 4 veces más; esa cifra es una estimación, no se midió.
- Mutaciones (cada una hace fallar al menos una prueba de 02-11o):
  - ventas que gastan cupo;
  - sin cupo por red;
  - sin desafío;
  - desafío reutilizable;
  - desafío no ligado a la dirección;
  - `cancel` que no devuelve el cupo de red ni el global.
- Concurrencia real: 30 procesos de 30 redes con tope 10 y reserva 2 → exactamente 12 códigos.

### Resend (solo lectura, 04-11-2026)

- Ver 02-11n: los registros DNS públicos (DKIM, SPF y MX de `send.`, DMARC `p=none` del dominio principal) están presentes.
- El panel de Resend no estaba disponible: no había sesión iniciada y no se inició ninguna. La clave de producción da `no_access`.
- El estado «Verified» y la entrega real **siguen sin verificarse**. Solo se pueden confirmar en el panel, o con un envío de prueba controlado y autorizado.

## 02-11p — verificación de lo publicado en 02-11o y desafío acotado en el navegador

**Estado comprobado al empezar (04-11-2026):**
- `main` del backend = `9c73576`, que es el merge del PR #15 `fix-02-11o`. Contiene `verifyStore.js` con cupo por red, desafío, reserva y renovación, más `test/verificacion-02-11o.test.mjs` y `test/fixtures/pow.mjs`.
- Un clon limpio de `main` da `npm test` **193 de 193** y `node scripts/riesgo-codigos.mjs` funciona.
- En la rama, el commit `294bf55` era un estado intermedio de la subida por la web de GitHub: solo traía el cierre y el script. Los commits siguientes (`f50dd66`, `c814134`, `1010de4`, `7c9f5a6` y `d017418`) agregaron el código y las pruebas antes del merge.
- Producción `/health` antes de esta ronda: `2026.11.04-o`, commit `9c73576`.

**Cambios del backend (solo pruebas):**
- `test/riesgo-codigos.test.mjs` simula al atacante contra el almacén real, con los límites de producción. Mide cuántos pedidos caen en cada nivel de desafío y comprueba que las cifras del script coinciden: 360 códigos, 70 redes, 90 IP y 3.74·10⁷ hashes con 16 y 18 bits.
- Otra prueba ejecuta el script como comando y comprueba que todos los parámetros vienen de `codeRiskParams()`.

**Frontend (2026.11.04-p):** el desafío ahora muestra el progreso, se puede cancelar y se detiene a los 30 s. Cada salida tiene su mensaje en ES/EN.

**Medición del desafío en Chromium headless** (`solveChallenge` real, 20 muestras por caso; la CPU lenta se simuló con `Emulation.setCPUThrottlingRate`):

| CPU | Bits | Mediana | p90 | Máximo |
|---|---|---|---|---|
| Normal | 16 | 119 ms | 492 ms | 801 ms |
| Normal | 18 | 363 ms | 1.5 s | 2.3 s |
| 6 veces más lenta (aprox. móvil de gama baja) | 16 | 0.9 s | 2.0 s | 3.8 s |
| 6 veces más lenta | 18 | 1.7 s | 8.0 s | 8.2 s |

El tiempo de resolución sigue una distribución geométrica con cola larga. El límite de 30 s queda a varias veces la mediana del peor caso medido. Si se alcanza, no se pide ningún código y se explica qué hacer.

## 02-11q — Estado de envíos observable sin enviar nada (2026-11-04)

- `/health.emailSends`: desde el último arranque, cuántos envíos reales aceptó o rechazó Resend, hora del último de cada uno y el tipo del último rechazo (`validation_error`, `domain_not_verified`, `api_key`, `rate_limit`, `network`, `other`). Solo conteos y horas: ninguna dirección, asunto, id ni texto del error. «Aceptado» = Resend tomó el correo; **no** prueba que llegó al buzón. En `EMAIL_DRY_RUN` no cuenta nada.
- `/health.emailSender.domain`: `no_access` pasa a `not_checkable_with_key` — la clave (solo envío) no puede leer dominios; no dice nada del dominio ni de la entrega.
- Pruebas: `test/verificacion-02-11q.test.mjs` (3; la prueba 2 falla si no se cuenta el rechazo — comprobado por mutación). Suite: 198/198.
- Evidencia de producción (solo lectura, registros de Railway, 30 días): ~21 búsquedas con resultados y ningún «Search lead email failed», «case email failed» ni «/email/report» con error. Indica que Resend aceptó esos envíos (con un remitente de dominio no verificado Resend los rechazaría), pero no es observación de recepción.
- Aparte: `❌ Unblocker attempt 1 failed: 401` en cada búsqueda — las credenciales OXY_UNBLOCK_USER/PASS de Oxylabs Web Unblocker son rechazadas; la búsqueda funciona por el respaldo (Web Scraper API). No se cambiaron variables.

## 02-11r — Certificados TLS verificados aunque la variable diga lo contrario (2026-11-04)

- Hallazgo (alto, confirmado en registros de Railway): producción arranca con `NODE_TLS_REJECT_UNAUTHORIZED=0` («makes TLS connections and HTTPS requests insecure»). Eso apagaba la verificación de certificados de todo el proceso: la clave de Resend, la de Groq y cada lead viajaban sin comprobar a quién.
- Corrección (código, sin tocar variables): `src/tlsGuard.js` quita esa variable al arrancar, después de `.env` y antes de cualquier petición; el agente del Web Unblocker de Oxylabs conserva su excepción explícita. `ALLOW_INSECURE_TLS=1` volvería al comportamiento anterior. `/health.tls`: `verified` | `verified-override-ignored` | `insecure`.
- Pruebas: `test/tls-02-11q.test.mjs` (3): un servidor local con certificado autofirmado es rechazado aun con la variable en 0; con la protección desactivada pasa (la prueba sí detecta el fallo); `/health` lo informa.
- Pendiente para el dueño de Railway: borrar la variable `NODE_TLS_REJECT_UNAUTHORIZED` (ya no tiene efecto).

## 02-11s — Proveedores: contradicciones fuera antes de ordenar; ruta de búsqueda (2026-11-04)

- Reproducido: «guantes sin látex» aceptaba «Latex disposable gloves»; «compresor 220 V», «…380V»; «puntera compuesta», «Steel toe safety boots» (el filtro de relevancia solo compara palabras). El respaldo sin IA convertía «guantes desechables sin látex» en la palabra clave «guantes desechables látex».
- `src/services/specGate.js`: con la descripción ORIGINAL (ES/EN) quita, en todas las rutas (primera búsqueda, reintento corto), las publicaciones cuyo título contradice lo pedido: material excluido (látex), voltaje / voltaje excluido, fase, material de la puntera, repuesto o accesorio en lugar del producto. Lo no dicho no se quita (la página lo muestra «por confirmar»). Respuesta: `specExcluded` y `specReasons` ({es,en}).
- Palabra clave: los requisitos se agregan a la consulta a la plataforma («220v», «latex free», «composite toe») y un material excluido nunca se pide; la relevancia se mide con las palabras del producto. Prompt de Groq y respaldo sin IA corregidos («sin …» se trata como exclusión).
- Web Unblocker de Oxylabs: los registros de producción muestran 401 en cada búsqueda (credenciales rechazadas) y respuesta del Scraper API en el mismo segundo. Tras un 401/407 se omite 6 h (`UNBLOCK_PAUSE_MS`); `OXY_UNBLOCK_DISABLED=1` lo apaga. `/health.searchRoute` dice qué ruta respondió la última búsqueda.
- Pruebas: `test/proveedores-02-11s.test.mjs` (6, incluye recorrido completo en servidor con plataforma simulada; quitar el filtro hace fallar 3), `test/busqueda-02-11s.test.mjs` (3: 401 → respaldo sin reintento ni espera, siguiente búsqueda sin Unblocker, fallo total → lista vacía).
