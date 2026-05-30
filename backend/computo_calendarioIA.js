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
   EJECUCIÓN SEGURA DE QUERYS
   -------------------------------------------------------------------------- */
async function safeQuery(sql) {
  try {
    const r = await pool.query(sql);
    return r.rows;
  } catch (e) {
    console.warn(`⚠️ query falló (${e.message.split('\n')[0]}). Usando valores por defecto.`);
    return [];
  }
}

/* --------------------------------------------------------------------------
   FUNCIÓN PRINCIPAL: Lógica de Empresario (50 años de experiencia)
   Genera precios basados en estadísticas y comportamiento humano, 
   y los guarda en public.calendario.ai_price.
   -------------------------------------------------------------------------- */
async function calcularPreciosAI(fechaInicio, fechaFin) {
  console.log(`👔 Empresario AI: Analizando el mercado del ${fechaInicio} al ${fechaFin}`);

  // 1. Leer todas las tablas para conocer el contexto estadístico
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

  // 2. Construir índices de la base de datos
  const pondDias = {};
  rDias.forEach(r => { pondDias[r.id_day] = r.pond_day_user; });

  const pondMeses = {};
  rMeses.forEach(r => { pondMeses[r.id_month] = r.pond_month_user; });

  const cfg = rConfig[0] || {};
  const infDias = etiquetaAMult(cfg.peso_dias_user || "Medio");
  const infMeses = etiquetaAMult(cfg.peso_meses_user || "Medio");
  const infEsp = etiquetaAMult(cfg.peso_fechas_especiales_user || "Medio");

  const mapaEsp = {};
  rEspeciales.forEach(fe => {
    const ini = new Date(fe.fi + 'T00:00:00');
    const fin = new Date(fe.ff + 'T00:00:00');
    for (let d = new Date(ini); d <= fin; d.setDate(d.getDate() + 1)) {
      mapaEsp[d.toISOString().split('T')[0]] = etiquetaAMult(fe.pond_especial_user);
    }
  });

  const reservadas = {};
  rReservas.forEach(r => { reservadas[r.fecha] = Number(r.price); });

  // 3. Limites del negocio (Definidos por la experiencia)
  const baseline = 400000;
  const FLOOR = 200000;     // Nunca regalar el salón, hay costos fijos
  const CEILING = 1500000;  // Techo un poco más alto para exprimir la alta demanda

  const rows = [];
  const cur = new Date(fechaInicio + 'T00:00:00');
  const end = new Date(fechaFin + 'T00:00:00');
  const hoy = new Date(); // Para calcular anticipación

  // 4. Calcular precio día por día usando las "Reglas de Oro"
  while (cur <= end) {
    const fecha = cur.toISOString().split('T')[0];
    
    // Avanzamos el cursor para la siguiente iteración
    const currentIterDate = new Date(cur); 
    cur.setDate(cur.getDate() + 1);

    let precio;
    if (reservadas[fecha] !== undefined) {
      // Si ya está rentado, respetamos el precio cerrado
      precio = reservadas[fecha];
    } else {
      const dow = currentIterDate.getDay();
      const month = currentIterDate.getMonth() + 1;

      // Multiplicadores base del sistema original
      const wDia = 1 + (etiquetaAMult(pondDias[dow] || "Medio") - 1) * infDias;
      const wMes = 1 + (etiquetaAMult(pondMeses[month] || "Media") - 1) * infMeses;
      const wEsp = 1 + ((mapaEsp[fecha] || 1.00) - 1) * infEsp;

      // --- INICIO DE LA LÓGICA DEL EMPRESARIO EXPERTO ---
      let wExperto = 1.0;
      const diasFaltantes = Math.ceil((currentIterDate - hoy) / (1000 * 60 * 60 * 24));

      // Regla de Oro 1: "Sábados de temporada alta valen oro"
      // Mayo, Octubre (Bodas) y Diciembre (Posadas)
      if (dow === 6 && (month === 5 || month === 10 || month === 12)) {
        wExperto *= 1.30; // 30% más, la gente pagará porque no hay lugares
      }

      // Regla de Oro 2: "Manejo del tiempo y la desesperación"
      if (diasFaltantes > 0 && diasFaltantes <= 30) {
        if (dow >= 1 && dow <= 4) {
          // Lunes a Jueves vacíos a menos de un mes: "Mejor ganar algo que nada"
          wExperto *= 0.85; // 15% de descuento para incentivar eventos exprés
        } else if (dow === 5 || dow === 6) {
          // Viernes y Sábados vacíos a última hora: "El cliente está desesperado"
          wExperto *= 1.15; // 15% de recargo por solucionarles la vida
        }
      }

      // Regla de Oro 3: "El que planea con mucho tiempo paga un extra por apartar la fecha"
      if (diasFaltantes > 365) {
        wExperto *= 1.10; // 10% extra por bloquear la agenda con más de un año
      }
      // --- FIN DE LA LÓGICA DEL EMPRESARIO EXPERTO ---

      // Calculamos el precio final aplicando todos los factores
      precio = Math.round(Math.max(FLOOR, Math.min(CEILING, baseline * wDia * wMes * wEsp * wExperto)));
    }

    rows.push({ fecha, precio });
  }

  // 5. Garantizar que la columna ai_price exista en la base de datos
  try {
    await pool.query(
      `ALTER TABLE calendario ADD COLUMN IF NOT EXISTS ai_price NUMERIC DEFAULT 400000`
    );
  } catch (e) {
    console.warn("⚠️ No se pudo agregar la columna ai_price:", e.message);
  }

  // 6. Guardar en calendario.ai_price
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const { fecha, precio } of rows) {
      const d = new Date(fecha + 'T00:00:00');
      // Insertamos asegurando que el dato va EXACTAMENTE a la columna ai_price
      await client.query(
        `INSERT INTO calendario
           (start_date, id_day, id_month, id_year, ai_price, special_day)
         VALUES ($1, $2, $3, $4, $5, FALSE)
         ON CONFLICT (start_date)
         DO UPDATE SET ai_price = EXCLUDED.ai_price`,
        [fecha, d.getDay(), d.getMonth() + 1, d.getFullYear(), precio]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Empresario AI: ${rows.length} fechas calculadas y guardadas exitosamente en ai_price.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error en la transacción del Empresario AI:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { calcularPreciosAI };