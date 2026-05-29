const pool = require("./db");

/* ==========================================================================
   CONVERSIÓN CUALITATIVO → MULTIPLICADOR
   Basado en el catálogo oficial cat_ponderaciones de la BD.
   Escala lineal: Muy bajo=0.60 | Bajo=0.80 | Medio=1.00 | Alto=1.20 | Muy alto=1.40
   ========================================================================== */
const MAPA_MULTIPLICADOR = {
  "muy bajo":  0.60,
  "muy baja":  0.60,
  "bajo":      0.80,
  "baja":      0.80,
  "medio":     1.00,
  "media":     1.00,
  "alto":      1.20,
  "alta":      1.20,
  "muy alto":  1.40,
  "muy alta":  1.40
};

function etiquetaAMultiplicador(etiqueta) {
  return MAPA_MULTIPLICADOR[(etiqueta || "medio").toLowerCase().trim()] ?? 1.00;
}

/**
 * FUNCIÓN UTILITARIA: Lógica matemática portada de computo_calendario.py
 *
 * Lee desde la BD:
 *   - ponderacion_dias        → peso cualitativo por día de la semana
 *   - ponderacion_meses       → peso cualitativo por mes
 *   - configuracion_pesos_reglas → factor de influencia global por dimensión
 *   - fechas_especiales       → rangos con ponderación especial (vacaciones, festividades, etc.)
 *
 * Fórmula por fecha:
 *   precio = baseline × wDia × wMes × wEspecial
 *   Cada w se amplifica/amortigua por su factor de influencia global.
 *
 * @param {string}   fechaInicio
 * @param {string}   fechaFin
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
             fecha_inicio::text,
             fecha_fin::text,
             pond_especial_user
      FROM fechas_especiales
      ORDER BY fecha_inicio
    `)
  ]);

  // --- 2. CONSTRUIR ÍNDICES EN MEMORIA ---
  const pondDias = {};
  dbDias.rows.forEach(r => { pondDias[r.id_day] = r.pond_day_user; });

  const pondMeses = {};
  dbMeses.rows.forEach(r => { pondMeses[r.id_month] = r.pond_month_user; });

  // Config global de influencia por factor (una sola fila)
  const cfg = dbConfig.rows[0] || {};
  const infDias      = etiquetaAMultiplicador(cfg.peso_dias_user);
  const infMeses     = etiquetaAMultiplicador(cfg.peso_meses_user);
  const infEspecial  = etiquetaAMultiplicador(cfg.peso_fechas_especiales_user);

  // Índice de fechas especiales: { "YYYY-MM-DD": multiplicador }
  const mapaEspeciales = {};
  dbEspeciales.rows.forEach(fe => {
    const inicio = new Date(fe.fecha_inicio + 'T00:00:00');
    const fin    = new Date(fe.fecha_fin    + 'T00:00:00');
    for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().split('T')[0];
      mapaEspeciales[iso] = etiquetaAMultiplicador(fe.pond_especial_user);
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
    // Precio de reservación confirmada tiene prioridad absoluta (equivalente a fillna)
    if (reservacionesConfirmadas[fecha]) {
      finalCalendar[fecha] = reservacionesConfirmadas[fecha];
      return;
    }

    const fechaObj  = new Date(fecha + 'T00:00:00');
    const dayOfWeek = fechaObj.getDay();
    const month     = fechaObj.getMonth() + 1;

    // Multiplicador base por día → amplificado por su factor de influencia global
    const mDia  = etiquetaAMultiplicador(pondDias[dayOfWeek]  || "Medio");
    const mMes  = etiquetaAMultiplicador(pondMeses[month]     || "Medio");

    // wX = 1 + (mX - 1) * influencia  →  influencia Medio=1 reproduce mX tal cual
    const wDia = 1 + (mDia - 1) * infDias;
    const wMes = 1 + (mMes - 1) * infMeses;

    // Fecha especial desde BD (vacaciones, festividades, etc.)
    const mEspecial = mapaEspeciales[fecha] || 1.00;
    const wEspecial = 1 + (mEspecial - 1) * infEspecial;

    // Fórmula: (Precio base) × (Peso día) × (Peso mes) × (Peso evento especial)
    let projectedPrice = baselinePrice * wDia * wMes * wEspecial;

    // Aplicar límites (equivalente a .clip())
    projectedPrice = Math.max(PRICE_FLOOR, Math.min(PRICE_CEILING, projectedPrice));
    finalCalendar[fecha] = Math.round(projectedPrice);
  });

  // --- 5. OUTPUT ---
  return finalCalendar;
}

module.exports = { calcularPreciosEstadisticos };
