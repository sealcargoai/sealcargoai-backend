# Cierre 29-b · backend

- `/api/email/quote`: rechaza (400) objetos o arrays en campos de texto, listas con elementos no textuales, `totalCost` no numérico, cantidades con notación/rangos/aproximaciones y presupuestos malformados **antes** de registrar o enviar correo.
- `/api/email/lead`: rechaza campos no textuales.
- `/api/suppliers/search`: valida tipos y formatos **antes** de reservar una búsqueda gratuita (antes se reservaba y luego se devolvía); cantidad solo entero plano, presupuesto solo monto plano.
- `EMAIL_DRY_RUN=1`: ningún correo puede salir (cliente Resend sustituido); `/health` → `emailDryRun`.
- Versión `2026.10.29-b`.
- Prueba sustituida: `security.test.mjs` aceptaba un caso con `product` objeto (se registraba sin producto). Se reemplazó por una comprobación más fuerte: esos cuerpos se rechazan y no generan correo.

Pruebas: `npm test` (servidor real en puerto libre, Resend simulado, destinatario QA). Archivo nuevo: `test/cierre-29-b.test.mjs`.
