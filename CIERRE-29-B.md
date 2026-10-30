# Cierre 29-b · backend

- `/api/email/quote`: rechaza (400) objetos o arrays en campos de texto, listas con elementos no textuales, `totalCost` no numérico, cantidades con notación/rangos/aproximaciones y presupuestos malformados **antes** de registrar o enviar correo.
- `/api/email/lead`: rechaza campos no textuales.
- `/api/suppliers/search`: valida tipos y formatos **antes** de reservar una búsqueda gratuita (antes se reservaba y luego se devolvía); cantidad solo entero plano, presupuesto solo monto plano.
- `EMAIL_DRY_RUN=1`: ningún correo puede salir (cliente Resend sustituido); `/health` → `emailDryRun`.
- Versión `2026.10.29-b`.
- Prueba sustituida: `security.test.mjs` aceptaba un caso con `product` objeto (se registraba sin producto). Se reemplazó por una comprobación más fuerte: esos cuerpos se rechazan y no generan correo.

Pruebas: `npm test` (servidor real en puerto libre, Resend simulado, destinatario QA). Archivo nuevo: `test/cierre-29-b.test.mjs`.

## 30-b · prueba intermitente del backend

`test/security.test.mjs` elegía un puerto al azar entre 4000 y 4089. El 4045 está en la lista de puertos que `fetch()` rechaza («bad port»), así que alrededor de 1 de cada 90 corridas fallaban sus 8 pruebas con «fetch failed» (encontrado en la segunda ronda de 30-b, causa confirmada registrando `error.cause`). Se salta ese puerto. Solo cambia la prueba; el servidor no cambia.
