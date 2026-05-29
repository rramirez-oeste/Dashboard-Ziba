const express = require("express");
const cors    = require("cors");
const pool    = require("./db");
const { calcularPreciosEstadisticos } = require("./computo_calendario");

const app = express();
app.use(cors());
app.use(express.json());

const OLLAMA_URL = "http://10.207.64.82:11434/api/generate";
const MODELO     = "qwen2.5:7b-instruct";

/* ==========================================================================
   UTILIDADES
   ========================================================================== */
function generarArregloFechas(inicio, fin) {
  const fechas = [];
  const cur = new Date(inicio + 'T00:00:00');
  const end = new Date(fin    + 'T00:00:00');
  while (cur <= end) {
    fechas.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return fechas;
}

/* ==========================================================================
   MOTOR DE RECALCULO — se llama en segundo plano tras cada escritura en BD
   Calcula precios para 2025-01-01 → 2027-12-31 y guarda en 'calendario'
   ========================================================================== */
let recalculoPendiente = false;

async function recalcularYGuardarCalendario() {
  if (recalculoPendiente) return;   // evitar ejecuciones simultáneas
  recalculoPendiente = true;
  try {
    const FECHA_INICIO = "2025-01-01";
    const FECHA_FIN    = "2027-12-31";

    // Leer todas las reservaciones confirmadas
    const dbRes = await pool.query(
      `SELECT TO_CHAR(fecha_evento,'YYYY-MM-DD') AS fecha, precio_final
       FROM reservaciones WHERE estatus = 'confirmado'`
    );
    const confirmadas = {};
    dbRes.rows.forEach(r => { confirmadas[r.fecha] = Number(r.precio_final); });

    // Calcular
    const precios = await calcularPreciosEstadisticos(
      FECHA_INICIO, FECHA_FIN, confirmadas, generarArregloFechas
    );

    // Guardar / actualizar en 'calendario' usando upsert
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [fecha, precio] of Object.entries(precios)) {
        const d = new Date(fecha + 'T00:00:00');
        await client.query(
          `INSERT INTO calendario (fecha, id_day, id_month, id_year, ia_price, holiday)
           VALUES ($1,$2,$3,$4,$5,FALSE)
           ON CONFLICT (fecha) DO UPDATE SET ia_price = EXCLUDED.ia_price`,
          [fecha, d.getDay(), d.getMonth()+1, d.getFullYear(), precio]
        );
      }
      await client.query("COMMIT");
      console.log(`✅ Calendario recalculado (${Object.keys(precios).length} fechas).`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("⚠️ Error en recalcularYGuardarCalendario:", err.message);
  } finally {
    recalculoPendiente = false;
  }
}

/* helper: lanza el recalculo en background sin bloquear la respuesta HTTP */
function triggerRecalculo() {
  recalcularYGuardarCalendario().catch(e =>
    console.error("⚠️ Trigger recalculo error:", e.message)
  );
}

/* ==========================================================================
   HEALTHCHECK
   ========================================================================== */
app.get("/health", (req, res) => res.json({ status: "ok" }));

/* ==========================================================================
   1. ESTRATEGIA DEL PERIODO — Lee todo desde la BD (sin cómputo en request)
   ========================================================================== */
app.get("/estrategia", async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin } = req.query;
    if (!fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: "Faltan fecha_inicio y fecha_fin" });

    const [dbCal, dbDias, dbMeses, dbRes] = await Promise.all([
      pool.query(
        `SELECT TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, ia_price
         FROM calendario WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha`,
        [fecha_inicio, fecha_fin]
      ),
      pool.query("SELECT id_day, pond_day_user, pond_day_ia FROM ponderacion_dias"),
      pool.query("SELECT id_month, pond_month_user, pond_month_ia FROM ponderacion_meses"),
      pool.query(
        `SELECT TO_CHAR(fecha_evento,'YYYY-MM-DD') AS fecha, precio_final
         FROM reservaciones WHERE estatus='confirmado'
         AND fecha_evento BETWEEN $1 AND $2`,
        [fecha_inicio, fecha_fin]
      )
    ]);

    // Precios: reservación confirmada tiene prioridad sobre caché IA
    const reservadas = {};
    dbRes.rows.forEach(r => { reservadas[r.fecha] = Number(r.precio_final); });

    const precios = {};
    dbCal.rows.forEach(r => {
      precios[r.fecha] = reservadas[r.fecha] ?? Number(r.ia_price);
    });
    // Si la caché aún no tiene datos para el periodo, usar reservadas al menos
    Object.assign(precios, reservadas);

    // Ponderación días
    const pondDiasUser = {}, pondDiasIA = {};
    dbDias.rows.forEach(r => {
      pondDiasUser[r.id_day] = r.pond_day_user;
      pondDiasIA[r.id_day]   = r.pond_day_ia;
    });

    // Ponderación meses
    const pondMesesUser = {}, pondMesesIA = {};
    dbMeses.rows.forEach(r => {
      pondMesesUser[r.id_month - 1] = r.pond_month_user;
      pondMesesIA[r.id_month  - 1] = r.pond_month_ia;
    });

    const mesId = new Date(fecha_inicio + 'T00:00:00').getMonth() + 1;
    const mesFila = dbMeses.rows.find(m => m.id_month === mesId) || {};

    return res.json({
      precios_sugeridos_calendario:    precios,
      ponderacion_dias_user:           pondDiasUser,
      ponderacion_dias_ia:             pondDiasIA,
      estacionalidad_meses_completo_user: pondMesesUser,
      estacionalidad_meses_completo_ia:   pondMesesIA,
      estacionalidad_periodo_user: mesFila.pond_month_user || "Media",
      estacionalidad_periodo_ia:   mesFila.pond_month_ia   || "Media",
      cache_completa: dbCal.rows.length > 0
    });
  } catch (err) {
    console.error("🔴 Error en /estrategia:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================================
   2. PONDERACIÓN DÍAS — lectura y actualización
   ========================================================================== */
app.get("/ponderacion-dias", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id_day, pond_day_user, pond_day_ia FROM ponderacion_dias ORDER BY id_day"
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/actualizar-ponderacion-dia", async (req, res) => {
  try {
    const { id_day, pond_day_user } = req.body;
    await pool.query(
      "UPDATE ponderacion_dias SET pond_day_user=$1 WHERE id_day=$2",
      [pond_day_user, id_day]
    );
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================================================
   3. PONDERACIÓN MESES — lectura y actualización
   ========================================================================== */
app.get("/ponderacion-meses", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id_month, pond_month_user, pond_month_ia FROM ponderacion_meses ORDER BY id_month"
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/actualizar-ponderacion-mes", async (req, res) => {
  try {
    const { id_month, pond_month_user } = req.body;
    await pool.query(
      "UPDATE ponderacion_meses SET pond_month_user=$1 WHERE id_month=$2",
      [pond_month_user, id_month]
    );
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================================================
   4. PERIODOS ESPECIALES
   ========================================================================== */
app.get("/periodos-especiales", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre,
              TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
              TO_CHAR(fecha_fin,   'YYYY-MM-DD') AS fecha_fin,
              pond_user, pond_ia
       FROM periodos_especiales ORDER BY fecha_inicio`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/periodos-especiales", async (req, res) => {
  try {
    const { nombre, fecha_inicio, fecha_fin, pond_user, pond_ia } = req.body;
    if (!fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: "Faltan fechas" });
    const r = await pool.query(
      `INSERT INTO periodos_especiales (nombre,fecha_inicio,fecha_fin,pond_user,pond_ia)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nombre||'', fecha_inicio, fecha_fin, pond_user??50, pond_ia??50]
    );
    res.json(r.rows[0]);
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/periodos-especiales/:id", async (req, res) => {
  try {
    const { nombre, fecha_inicio, fecha_fin, pond_user, pond_ia } = req.body;
    await pool.query(
      `UPDATE periodos_especiales
       SET nombre=$1, fecha_inicio=$2, fecha_fin=$3, pond_user=$4, pond_ia=$5
       WHERE id=$6`,
      [nombre||'', fecha_inicio, fecha_fin, pond_user??50, pond_ia??50, req.params.id]
    );
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/periodos-especiales/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM periodos_especiales WHERE id=$1", [req.params.id]);
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================================================
   5. CONFIGURACIÓN DE PESOS GLOBALES (persiste en BD)
   ========================================================================== */
app.get("/pesos-usuario", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM configuracion_pesos_reglas LIMIT 1");
    if (r.rows.length === 0) return res.json({});
    const cfg = r.rows[0];
    res.json({
      dias:             cfg.peso_dias_user,
      mes:              cfg.peso_meses_user,
      fechas_especiales: cfg.peso_fechas_especiales_user
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/pesos-usuario", async (req, res) => {
  try {
    const { key, value } = req.body;
    const colMap = {
      dias:             'peso_dias_user',
      mes:              'peso_meses_user',
      fechas_especiales:'peso_fechas_especiales_user'
    };
    const col = colMap[key];
    if (!col) return res.status(400).json({ error: "Clave inválida" });
    await pool.query(`UPDATE configuracion_pesos_reglas SET ${col}=$1`, [value]);
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================================================
   6. RESERVACIONES
   ========================================================================== */
app.get("/reservaciones", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id_reservation, TO_CHAR(fecha_evento,'YYYY-MM-DD') AS fecha_evento,
              precio_final, estatus, nombre_cliente
       FROM reservaciones WHERE estatus='confirmado' ORDER BY fecha_evento`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/reservaciones", async (req, res) => {
  try {
    const { fecha_evento, precio_final, nombre_cliente } = req.body;
    if (!fecha_evento || !precio_final)
      return res.status(400).json({ error: "Faltan parámetros" });

    const existe = await pool.query(
      "SELECT 1 FROM reservaciones WHERE fecha_evento=$1 AND estatus='confirmado'",
      [fecha_evento]
    );
    if (existe.rows.length > 0)
      return res.status(400).json({ error: "Esta fecha ya tiene una reservación confirmada" });

    const r = await pool.query(
      `INSERT INTO reservaciones (fecha_evento,precio_final,estatus,nombre_cliente)
       VALUES ($1,$2,'confirmado',$3) RETURNING *`,
      [fecha_evento, precio_final, nombre_cliente||"Cliente Gala"]
    );
    res.json({ mensaje: "Reservación guardada", reservacion: r.rows[0] });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/reservaciones/:id", async (req, res) => {
  try {
    await pool.query(
      "UPDATE reservaciones SET estatus='cancelado' WHERE id_reservation=$1",
      [req.params.id]
    );
    res.json({ status: "ok" });
    triggerRecalculo();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================================================
   7. INICIALIZACIÓN DE TABLAS Y ARRANQUE
   ========================================================================== */
async function esperarPostgres(maxIntentos = 15, intervaloMs = 2000) {
  for (let i = 1; i <= maxIntentos; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ PostgreSQL listo.");
      return;
    } catch {
      console.log(`⏳ Esperando PostgreSQL... intento ${i}/${maxIntentos}`);
      await new Promise(r => setTimeout(r, intervaloMs));
    }
  }
  throw new Error("PostgreSQL no respondió.");
}

async function inicializarTablas() {
  await esperarPostgres();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendario (
      fecha    DATE    PRIMARY KEY,
      id_day   INTEGER NOT NULL,
      id_month INTEGER NOT NULL,
      id_year  INTEGER NOT NULL,
      ia_price NUMERIC NOT NULL DEFAULT 400000,
      holiday  BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservaciones (
      id_reservation SERIAL PRIMARY KEY,
      fecha_evento   DATE    NOT NULL,
      precio_final   NUMERIC NOT NULL,
      estatus        TEXT    NOT NULL DEFAULT 'confirmado',
      nombre_cliente TEXT    NOT NULL DEFAULT 'Cliente Gala'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ponderacion_dias (
      id_day        INTEGER PRIMARY KEY,
      pond_day_user NUMERIC NOT NULL DEFAULT 50,
      pond_day_ia   NUMERIC NOT NULL DEFAULT 50
    )
  `);
  // Migrar TEXT → NUMERIC si existe con tipo incorrecto
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='ponderacion_dias' AND column_name='pond_day_user' AND data_type='text'
      ) THEN
        ALTER TABLE ponderacion_dias
          ALTER COLUMN pond_day_user TYPE NUMERIC USING 50,
          ALTER COLUMN pond_day_ia   TYPE NUMERIC USING 50;
        UPDATE ponderacion_dias SET pond_day_user=50, pond_day_ia=50;
      END IF;
    END $$;
  `);
  for (let d = 0; d <= 6; d++) {
    await pool.query(
      `INSERT INTO ponderacion_dias (id_day,pond_day_user,pond_day_ia)
       VALUES ($1,50,50) ON CONFLICT (id_day) DO NOTHING`, [d]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ponderacion_meses (
      id_month        INTEGER PRIMARY KEY,
      pond_month_user TEXT NOT NULL DEFAULT 'Media',
      pond_month_ia   TEXT NOT NULL DEFAULT 'Media'
    )
  `);
  for (let m = 1; m <= 12; m++) {
    await pool.query(
      `INSERT INTO ponderacion_meses (id_month,pond_month_user,pond_month_ia)
       VALUES ($1,'Media','Media') ON CONFLICT (id_month) DO NOTHING`, [m]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS periodos_especiales (
      id           SERIAL PRIMARY KEY,
      nombre       TEXT    NOT NULL DEFAULT '',
      fecha_inicio DATE    NOT NULL,
      fecha_fin    DATE    NOT NULL,
      pond_user    NUMERIC NOT NULL DEFAULT 50,
      pond_ia      NUMERIC NOT NULL DEFAULT 50
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracion_pesos_reglas (
      id                         SERIAL PRIMARY KEY,
      peso_dias_user             TEXT NOT NULL DEFAULT 'Medio',
      peso_meses_user            TEXT NOT NULL DEFAULT 'Medio',
      peso_fechas_especiales_user TEXT NOT NULL DEFAULT 'Medio'
    )
  `);
  // Garantizar que siempre haya exactamente una fila de configuración
  const cfgCount = await pool.query("SELECT COUNT(*) FROM configuracion_pesos_reglas");
  if (parseInt(cfgCount.rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO configuracion_pesos_reglas
       (peso_dias_user,peso_meses_user,peso_fechas_especiales_user)
       VALUES ('Medio','Medio','Medio')`
    );
  }

  console.log("✅ Tablas verificadas/creadas correctamente.");

  // Primer cálculo completo del calendario al arrancar
  console.log("🔄 Calculando calendario inicial...");
  await recalcularYGuardarCalendario();
}

inicializarTablas()
  .then(() => {
    app.listen(3000, () => {
      console.log("🚀 Servidor Zibá corriendo en http://localhost:3000");
    });
  })
  .catch(err => {
    console.error("❌ Error al inicializar:", err.message);
    process.exit(1);
  });
