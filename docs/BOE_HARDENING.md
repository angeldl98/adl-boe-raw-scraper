## Discovery endurecida
- Método A (DOM): se mantiene el listado Playwright, registra `found_dom`, longitud de HTML y URL de origen.
- Método B (XHR): listener `page.on('response')` captura URLs de detalle/subastas y añade candidatos únicos (`found_xhr`).
- Método C (continuidad): se consultan los últimos `INFER_LOOKBACK` URLs en `boe_subastas_raw`, se infiere idSub consecutivo por prefijo y año, y se valida con GET 200 + cuerpo > 500 chars (`found_inferred`).
- Todos los candidatos se deduplican y se limitan a `MAX_CANDIDATES` (default 100).

## Validación estricta
- Cada detalle debe tener: id BOE (`boeUid`), fecha, tipo de subasta, y autoridad (Juzgado/Órgano/Autoridad). Si falla, se descarta y se contabiliza en `discarded`.
- Solo los detalles validados se persisten en `boe_subastas_raw`.

## Modo degradado
- Si `found_dom = found_xhr = found_inferred = 0`, el run se marca `status=degraded`, no se persiste nada y se guarda evidencia (HTML, screenshot, fingerprint) en `pipeline_runs.stats` (`mode="degraded"`).

## Trazabilidad en pipeline_runs.stats
- Campos agregados: `found_dom`, `found_xhr`, `found_inferred`, `validated`, `discarded`, `mode`, `evidence_html`, `evidence_screenshot`, `dom_fingerprint`.

## Ejecución única
- Camino único: A → B → C → pool → validación → persistencia. Si el pool queda vacío, se degrada sin error y sin escribir datos.

