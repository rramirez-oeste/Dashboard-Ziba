const pool = require("./db");

/**
 * FUNCIÓN UTILITARIA: Lógica matemática portada de computo_calendario.py
 * Lee los pesos de días y meses desde la BD (ponderacion_dias / ponderacion_meses)
 * y calcula precios sugeridos para cada fecha del rango, respetando cotas.
 *
 * @param {string} fechaInicio       - YYYY-MM-DD
 * @param {string} fechaFin          - YYYY-MM-DD
 * @param {Object} reservacionesConfirmadas - { "YYYY-MM-DD": precioNumerico }
 * @param {Function} generarArregloFechas   - utilidad de server.js
 * @param {Function} esFeriadoMexico        - utilidad de server.js
 * @returns {Promise<Object>} finalCalendar - { "YYYY-MM-DD": precioRedondeado }
 */
async function calcularPreciosEstadisticos(
  fechaInicio,
  fechaFin,
  reservacionesConfirmadas,
  generarArregloFechas,
  esFeriadoMexico
) {
  const fechas = generarArregloFechas(fechaInicio, fechaFin);

  // --- 1. LEER SETUP DE PESOS DESDE LA BASE DE DATOS ---
  const [dbDias, dbMeses] = await Promise.all([
    pool.query("SELECT id_day, pond_day_user FROM ponderacion_dias"),
    pool.query("SELECT id_month, pond_month_user FROM ponderacion_meses")
  ]);

  // Construir tablas de pesos a partir de los registros de la BD
  const dayWeights = {};
  dbDias.rows.forEach(r => {
    dayWeights[r.id_day] = Number(r.pond_day_user);
  });

  const monthWeights = {};
  dbMeses.rows.forEach(r => {
    monthWeights[r.id_month] = Number(r.pond_month_user);
  });

  // --- 2. PESOS DE EVENTOS ESPECIALES ---
  const customWeights = {
    "Ninguno":    1.00,
    "Vacaciones": 1.50,
    "Festividad": 1.75
  };

  // --- 3. PRECIO BASE: PROMEDIO DEL HISTORIAL O VALOR POR DEFECTO ---
  const valoresConocidos = Object.values(reservacionesConfirmadas);
  let baselinePrice = 400000;
  if (valoresConocidos.length > 0) {
    baselinePrice = valoresConocidos.reduce((a, b) => a + b, 0) / valoresConocidos.length;
  }

  const PRICE_FLOOR  = 200000;
  const PRICE_CEILING = 1000000;

  let finalCalendar = {};

  // --- 4. APLICAR PESOS, CALCULAR Y RELLENAR ---
  fechas.forEach(fecha => {
    // Precio real de reservación confirmada tiene prioridad absoluta (equivalente a fillna)
    if (reservacionesConfirmadas[fecha]) {
      finalCalendar[fecha] = reservacionesConfirmadas[fecha];
      return;
    }

    const fechaObj  = new Date(fecha + 'T00:00:00');
    const dayOfWeek = fechaObj.getDay();
    const month     = fechaObj.getMonth() + 1;

    const wDay   = dayWeights[dayOfWeek]  || 1.0;
    const wMonth = monthWeights[month]    || 1.0;

    let tipoEvento = "Ninguno";
    if (esFeriadoMexico(fecha)) tipoEvento = "Festividad";
    const wCustom = customWeights[tipoEvento] || 1.0;

    // Fórmula: (Precio base) * (Peso día) * (Peso mes) * (Peso evento)
    let projectedPrice = baselinePrice * wDay * wMonth * wCustom;

    // Aplicar límites (equivalente a .clip())
    projectedPrice = Math.max(PRICE_FLOOR, Math.min(PRICE_CEILING, projectedPrice));
    finalCalendar[fecha] = Math.round(projectedPrice);
  });

  // --- 5. OUTPUT ---
  return finalCalendar;
}

module.exports = { calcularPreciosEstadisticos };
