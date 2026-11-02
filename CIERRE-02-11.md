# Cierre 02-11 — auditoría integral (backend)

Versión: `2026.11.02-a`. Base: `5190ebe` (producción al 2 de noviembre de 2026).
No se cambiaron destinatarios, credenciales, variables de entorno ni controles de seguridad.

## Defectos corregidos (causa raíz)

| # | Defecto | Causa raíz | Corrección |
|---|---|---|---|
| B1 | El aviso de búsqueda decía «Proveedores calificados» y «Mejor proveedor» | Etiquetas antiguas | «Coincidencias que pasaron los filtros», «Primera coincidencia de la lista» y aclaración de que no confirman existencia, identidad, capacidad, calidad, oferta vigente ni idoneidad |
| B2 | «Tipo de producto: machinery / other» y «Destino: GT» en el aviso | Se enviaba la clave interna | `categoryEs` y «Guatemala» |
| B3 | Sin presupuesto del cliente, el aviso mostraba «Presupuesto (US$) 50000» | Se reportaba el valor interno por defecto | Solo el presupuesto que el cliente dio |
| B4 | Repetir la misma búsqueda (reintento, recarga) enviaba otro aviso | El aviso se enviaba también en la repetición propia (caché) | Sin aviso en la repetición propia |
| B5 | El aviso de consulta iniciada cortaba la descripción en 1,000 caracteres (el sitio acepta 1,500) | Límite distinto | 1,500 |
| B6 | Informe por correo: «Costo total estimado: Q64,140 (US$8,119) ,» para una estimación sin flete | El filtro quitaba «sin flete» y dejaba la coma | «Costo estimado preliminar, sin flete»; sin separador suelto; «Hola:» sin nombre |
| B7 | Correo del caso: «Costo total estimado» para un costo sin flete | Etiqueta | «Costo estimado preliminar (sin flete)» |
| B8 | Palabra clave de respaldo (sin IA) con letras sueltas de unidades («… tornillo v») | No se descartaban tokens de 1 letra | Se descartan |

## Pruebas

- `test/cierre-02-11.test.mjs` (6 casos; los 6 fallan sobre `5190ebe`), con `test/fixtures/` (búsqueda ficticia, sin red).
- Suite completa `npm test`.

## Pendiente que no se puede comprobar desde el código

Los registros de prueba van a `QA_LEADS_EMAIL` **solo si esa variable existe en Railway**; si no existe,
van al buzón comercial (ventas@) marcados [PRUEBA]. `/health` no informa los destinatarios, así que el
aislamiento de QA en producción debe confirmarse en Railway antes de cualquier prueba de envío.
