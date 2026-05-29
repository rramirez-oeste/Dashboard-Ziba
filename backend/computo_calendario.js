const pool = require("./db");

/* --------------------------------------------------------------------------
   CONVERSIÓN CUALITATIVA → MULTIPLICADOR
   -------------------------------------------------------------------------- */
const MAPA = {
  "muy bajo": 0.60, "muy baja": 0.60,
  "bajo":     0.80, "baja":     0.80,
  "medio":    1.00, "media":    1.00,
  "alto":     1.20, "alta":     1.20,
  "muy alto": 1.40, "muy alta": 1.40
};
const etiquetaAMult = e => MAPA[(e || "medio").toLowerCase().trim()] ?? 1.00;

/* --------------------------------------------------------------------------
   Ejecuta una query y devuelve sus filas, o [] si la tabla no existe.
   -------------------------------------------------------------------------- */
async function safeQuery(sql) {
  try {
    const r = await pool.query(sql);
    return r.rows;
  } catch (e) {
    console.warn(`⚠️  computo_calendario — query falló (${e.message.split('\n')[0]}). Usando valores por defecto.`);
    return [];
  }
}

/* --------------------------------------------------------------------------
   FUNCIÓN PRINCIPAL
   Lee desde la BD:
     - public.ponderacion_dias
     - public.ponderacion_meses
     - public.fechas_especiales
     - public.reservaciones
     - public.configuracion_pesos_reglas  (opcional — usa Medio si no existe)
   Guarda el resultado en public.calendario.computed_price.

   @param {string} fechaInicio  "YYYY-MM-DD"
   @param {string} fechaFin     "YYYY-MM-DD"
   -------------------------------------------------------------------------- */
async function calcularPreciosEstadisticos(fechaInicio, fechaFin) {
  console.log(`🔄 computo_calendario: calculando ${fechaInicio} → ${fechaFin}`);

  // 1. Leer todas las tablas (cada una con fallback seguro)
  const [rDias, rMeses, rConfig, rEspeciales, rReservas] = await Promise.all([
    safeQuery("SELECT id_day, pond_day_user FROM ponderacion_dias"),
    safeQuery("SELECT id_month, pond_month_user FROM ponderacion_meses"),
    safeQuery("SELECT * FROM configuracion_pesos_reglas LIMIT 1"),
    safeQuery(`
      SELECT TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fi,
             TO_CHAR(fecha_fin,   'YYYY-MM-DD') AS ff,
             pond_especial_user
      FROM fechas_especiales ORDER BY fecha_inicio
    `),
    safeQuery(`
      SELECT TO_CHAR(date_start,'YYYY-MM-DD') AS fecha, price
      FROM reservaciones WHERE status = 'confirmado'
    `)
  ]);

  console.log(`   ponderacion_dias:    ${rDias.length} filas`);
  console.log(`   ponderacion_meses:   ${rMeses.length} filas`);
  console.log(`   configuracion:       ${rConfig.length} filas`);
  console.log(`   fechas_especiales:   ${rEspeciales.length} filas`);
  console.log(`   reservaciones:       ${rReservas.length} filas`);

  // 2. Construir índices
  const pondDias = {};
  rDias.forEach(r => { pondDias[r.id_day] = r.pond_day_user; });

  const pondMeses = {};
  rMeses.forEach(r => { pondMeses[r.id_month] = r.pond_month_user; });

  const cfg    = rConfig[0] || {};
  const infDias  = etiquetaAMult(cfg.peso_dias_user              || "Medio");
  const infMeses = etiquetaAMult(cfg.peso_meses_user             || "Medio");
  const infEsp   = etiquetaAMult(cfg.peso_fechas_especiales_user || "Medio");

  const mapaEsp = {};
  rEspeciales.forEach(fe => {
    const ini = new Date(fe.fi + 'T00:00:00');
    const fin = new Date(fe.ff + 'T00:00:00');
    for (let d = new Date(ini); d <= fin; d.setDate(d.getDate() + 1)) {
      mapaEsp[d.toISOString().split('T')[0]] = etiquetaAMult(fe.pond_especial_user);
    }
  });

  // Reservaciones confirmadas: { "YYYY-MM-DD": precio }
  const reservadas = {};
  rReservas.forEach(r => { reservadas[r.fecha] = Number(r.price); });

  // 3. Precio base fijo — no usar el historial como baseline para evitar
  //    retroalimentación: precios altos → baseline sube → precios libres suben → etc.
  const baseline = 400000;

  const FLOOR   = 200000;
  const CEILING = 1000000;

  // 4. Calcular precio por fecha
  const rows = [];
  const cur  = new Date(fechaInicio + 'T00:00:00');
  const end  = new Date(fechaFin    + 'T00:00:00');

  while (cur <= end) {
    const fecha = cur.toISOString().split('T')[0];
    cur.setDate(cur.getDate() + 1);

    let precio;
    if (reservadas[fecha] !== undefined) {
      // Fecha reservada → copiar precio_final directamente
      precio = reservadas[fecha];
    } else {
      const dow   = new Date(fecha + 'T00:00:00').getDay();
      const month = new Date(fecha + 'T00:00:00').getMonth() + 1;

      const wDia = 1 + (etiquetaAMult(pondDias[dow] || "Medio")             - 1) * infDias;
      const wMes = 1 + (etiquetaAMult(pondMeses[month] || "Media")          - 1) * infMeses;
      const wEsp = 1 + ((mapaEsp[fecha] || 1.00)                            - 1) * infEsp;

      precio = Math.round(Math.max(FLOOR, Math.min(CEILING, baseline * wDia * wMes * wEsp)));
    }

    rows.push({ fecha, precio });
  }

  console.log(`   Filas a guardar: ${rows.length}`);

  // 5. Garantizar que computed_price existe antes de escribir
  try {
    await pool.query(
      `ALTER TABLE calendario ADD COLUMN IF NOT EXISTS computed_price NUMERIC DEFAULT 400000`
    );
  } catch (e) {
    console.warn("⚠️  No se pudo agregar columna computed_price:", e.message);
  }

  // 6. Guardar en calendario.computed_price
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const { fecha, precio } of rows) {
      const d = new Date(fecha + 'T00:00:00');
      await client.query(
        `INSERT INTO calendario
           (start_date, id_day, id_month, id_year, ia_price, computed_price, special_day)
         VALUES ($1, $2, $3, $4, $5, $5, FALSE)
         ON CONFLICT (start_date)
         DO UPDATE SET computed_price = EXCLUDED.computed_price`,
        [fecha, d.getDay(), d.getMonth() + 1, d.getFullYear(), precio]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ computo_calendario: ${rows.length} fechas actualizadas en computed_price.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ computo_calendario error al guardar:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { calcularPreciosEstadisticos };
