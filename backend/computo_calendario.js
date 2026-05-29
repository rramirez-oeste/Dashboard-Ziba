const pool = require("./db");

/* ==========================================================================
   CONVERSIÓN NUMÉRICA (0-100) → MULTIPLICADOR (0.60 – 1.40)
   Para ponderacion_dias (pond_day_user es NUMERIC 0-100)
   ========================================================================== */
function scoreAMultiplicador(score) {
  const s = parseFloat(score);
  if (isNaN(s)) return 1.00;
  // Escala lineal: 0 pts → 0.60 | 50 pts → 1.00 | 100 pts → 1.40
  return 0.60 + (s / 100) * 0.80;
}

/* ==========================================================================
   CONVERSIÓN CUALITATIVA → MULTIPLICADOR
   Para ponderacion_meses, periodos_especiales y configuracion_pesos_reglas
   ========================================================================== */
const MAPA_MULTIPLICADOR = {
  "muy bajo": 0.60, "muy baja": 0.60,
  "bajo":     0.80, "baja":     0.80,
  "medio":    1.00, "media":    1.00,
  "alto":     1.20, "alta":     1.20,
  "muy alto": 1.40, "muy alta": 1.40
};

function etiquetaAMultiplicador(etiqueta) {
  return MAPA_MULTIPLICADOR[(etiqueta || "medio").toLowerCase().trim()] ?? 1.00;
}

/**
 * Calcula precios sugeridos para un rango de fechas.
 *
 * Lee desde la BD:
 *   - ponderacion_dias            → peso numérico (0-100) por día de la semana
 *   - ponderacion_meses           → peso cualitativo por mes
 *   - configuracion_pesos_reglas  → factor de influencia global por dimensión
 *   - periodos_especiales         → rangos con ponderación especial
 *
 * Fórmula por fecha:
 *   precio = baseline × wDia × wMes × wEspecial
 *
 * @param {string}   fechaInicio          "YYYY-MM-DD"
 * @param {string}   fechaFin             "YYYY-MM-DD"
 * @param {Object}   reservacionesConfirmadas  { "YYYY-MM-DD": precioNumerico }
 * @param {Function} generarArregloFechas
 * @returns {Promise<Object>}  { "YYYY-MM-DD": precioRedondeado }
 */
async function calcularPreciosEstadisticos(
  fechaInicio,
  fechaFin,
  reservacionesConfirmadas,
  generarArregloFechas
) {
  const fechas = generarArregloFechas(fechaInicio, fechaFin);

  // --- 1. LEER SETUP COMPLETO DESDE LA BD EN PARALELO ---
  const [dbDias, dbMeses, dbConfig, dbEspeciales] = await Promise.all([
    pool.query("SELECT id_day, pond_day_user FROM ponderacion_dias"),
    pool.query("SELECT id_month, pond_month_user FROM ponderacion_meses"),
    pool.query("SELECT * FROM configuracion_pesos_reglas LIMIT 1"),
    pool.query(`
      SELECT nombre,
             TO_CHAR(fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
             TO_CHAR(fecha_fin,    'YYYY-MM-DD') AS fecha_fin,
             pond_user
      FROM periodos_especiales
      ORDER BY fecha_inicio
    `)
  ]);

  // --- 2. CONSTRUIR ÍNDICES EN MEMORIA ---
  const pondDias = {};
  dbDias.rows.forEach(r => { pondDias[r.id_day] = r.pond_day_user; });

  const pondMeses = {};
  dbMeses.rows.forEach(r => { pondMeses[r.id_month] = r.pond_month_user; });

  const cfg = dbConfig.rows[0] || {};
  const infDias     = etiquetaAMultiplicador(cfg.peso_dias_user);
  const infMeses    = etiquetaAMultiplicador(cfg.peso_meses_user);
  const infEspecial = etiquetaAMultiplicador(cfg.peso_fechas_especiales_user);

  // Índice de fechas especiales: { "YYYY-MM-DD": multiplicador }
  const mapaEspeciales = {};
  dbEspeciales.rows.forEach(fe => {
    const inicio = new Date(fe.fecha_inicio + 'T00:00:00');
    const fin    = new Date(fe.fecha_fin    + 'T00:00:00');
    for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().split('T')[0];
      mapaEspeciales[iso] = etiquetaAMultiplicador(fe.pond_user);
    }
  });

  // --- 3. PRECIO BASE: PROMEDIO DEL HISTORIAL O VALOR POR DEFECTO ---
  const valoresConocidos = Object.values(reservacionesConfirmadas);
  let baselinePrice = 400000;
  if (valoresConocidos.length > 0) {
    baselinePrice = valoresConocidos.reduce((a, b) => a + b, 0) / valoresConocidos.length;
  }

  const PRICE_FLOOR   = 200000;
  const PRICE_CEILING = 1000000;

  let finalCalendar = {};

  // --- 4. CALCULAR PRECIO POR FECHA ---
  fechas.forEach(fecha => {
    if (reservacionesConfirmadas[fecha]) {
      finalCalendar[fecha] = reservacionesConfirmadas[fecha];
      return;
    }

    const fechaObj  = new Date(fecha + 'T00:00:00');
    const dayOfWeek = fechaObj.getDay();
    const month     = fechaObj.getMonth() + 1;

    // Días usan escala numérica; meses usan escala cualitativa
    const mDia = scoreAMultiplicador(pondDias[dayOfWeek] ?? 50);
    const mMes = etiquetaAMultiplicador(pondMeses[month] || "Media");

    const wDia = 1 + (mDia - 1) * infDias;
    const wMes = 1 + (mMes - 1) * infMeses;

    const mEspecial = mapaEspeciales[fecha] || 1.00;
    const wEspecial = 1 + (mEspecial - 1) * infEspecial;

    let projectedPrice = baselinePrice * wDia * wMes * wEspecial;
    projectedPrice = Math.max(PRICE_FLOOR, Math.min(PRICE_CEILING, projectedPrice));
    finalCalendar[fecha] = Math.round(projectedPrice);
  });

  return finalCalendar;
}

module.exports = { calcularPreciosEstadisticos };
