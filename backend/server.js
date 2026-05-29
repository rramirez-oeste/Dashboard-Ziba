const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const OLLAMA_URL = "http://10.207.64.82:11434/api/generate";
const MODELO = "qwen2.5:7b-instruct"; 

/**
 * FUNCIÓN UTILITARIA: Genera un arreglo con todas las fechas YYYY-MM-DD entre un inicio y un fin
 */
function generarArregloFechas(inicio, fin) {
  let fechas = [];
  let fechaActual = new Date(inicio + 'T00:00:00');
  let fechaFin = new Date(fin + 'T00:00:00');
  
  while (fechaActual <= fechaFin) {
    fechas.push(fechaActual.toISOString().split('T')[0]);
    fechaActual.setDate(fechaActual.getDate() + 1);
  }
  return fechas;
}

/**
 * FUNCIÓN UTILITARIA: Parte un arreglo grande en sub-arreglos de un tamaño máximo (chunks)
 */
function segmentarArreglo(arreglo, tamañoMaximo) {
  let resultado = [];
  for (let i = 0; i < arreglo.length; i += tamañoMaximo) {
    resultado.push(arreglo.slice(i, i + tamañoMaximo));
  }
  return resultado;
}

/**
 * FUNCIÓN UTILITARIA: Detecta feriados oficiales en México para ajustar ponderaciones en vivo
 */
function esFeriadoMexico(fechaTexto) {
  const partes = fechaTexto.split('-');
  const mmdd = `${partes[1]}-${partes[2]}`;
  
  const feriadosFijos = [
    "01-01", // Año Nuevo
    "05-01", // Día del Trabajo
    "09-16", // Día de la Independencia
    "11-20", // Revolución Mexicana
    "12-25"  // Navidad
  ];
  
  return feriadosFijos.includes(mmdd);
}

const { calcularPreciosEstadisticos: _calcularPreciosEstadisticos } = require("./computo_calendario");

function calcularPreciosEstadisticos(fechaInicio, fechaFin, reservacionesConfirmadas) {
  return _calcularPreciosEstadisticos(fechaInicio, fechaFin, reservacionesConfirmadas, generarArregloFechas, esFeriadoMexico);
}
// Nota: calcularPreciosEstadisticos retorna una Promise — usar con await.

/* ==========================================================================
   1. RUTA CORE: OBTENER ESTRATEGIA MENSUAL O DE RANGO (HÍBRIDO COMPLETO)
   ========================================================================== */
app.post("/obtener-estrategia-periodo", async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin, es_recalculo_manual } = req.body;

    if (!fecha_inicio || !fecha_fin) {
      return res.status(400).json({ error: "Faltan los parámetros fecha_inicio o fecha_fin" });
    }

    const periodoCompleto = generarArregloFechas(fecha_inicio, fecha_fin);

    // ➡️ EXTRAER CONFIGURACIÓN ACTUAL DESDE TUS TABLAS DE PONDERACIÓN
    const dbPondDias = await pool.query("SELECT id_day, pond_day_user, pond_day_ia FROM ponderacion_dias");
    const dbPondMeses = await pool.query("SELECT id_month, pond_month_user, pond_month_ia FROM ponderacion_meses");

    // Convertir a diccionarios para manipulación rápida en memoria
    let scoreBaseDiasUser = {}; let scoreBaseDiasIA = {};
    dbPondDias.rows.forEach(r => {
      scoreBaseDiasUser[r.id_day] = r.pond_day_user;
      scoreBaseDiasIA[r.id_day] = r.pond_day_ia;
    });

    // 🏆 MAPEAR EL CATÁLOGO COMPLETO DE LOS 12 MESES PARA RESPONDER AL FRONTEND EN LUGAR DE HARDCODEAR
    let todosLosMesesBDUser = {};
    let todosLosMesesBDIA = {};
    dbPondMeses.rows.forEach(m => {
      const index = m.id_month - 1; // Base 1 a Base 0 de JS
      todosLosMesesBDUser[index] = m.pond_month_user;
      todosLosMesesBDIA[index] = m.pond_month_ia;
    });

    // Determinar mes representativo (basado en el inicio del rango solicitado)
    const mesRepresentativoId = new Date(fecha_inicio + 'T00:00:00').getMonth() + 1; // 1-12
    const configMesActual = dbPondMeses.rows.find(m => m.id_month === mesRepresentativoId) || { pond_month_user: "Media", pond_month_ia: "Media" };

    // ➡️ EXTRAER HISTORIAL REAL DE TU NUEVA TABLA 'reservaciones'
    const registrosDB = await pool.query(
      `SELECT TO_CHAR(fecha_evento, 'YYYY-MM-DD') as fecha, precio_final, estatus 
       FROM reservaciones 
       WHERE estatus = 'confirmado' AND fecha_evento BETWEEN $1 AND $2 
       ORDER BY fecha_evento ASC`,
      [fecha_inicio, fecha_fin]
    );
    const ocupadas = {};
    registrosDB.rows.forEach(r => ocupadas[r.fecha] = Number(r.precio_final));

/* ----------------------------------------------------------------------
       ⚠️ CAMINO A: RECALCULO MANUAL SOLICITADO DESDE EL FRONTEND (0 SEGUNDOS)
       ---------------------------------------------------------------------- */
    if (es_recalculo_manual) {
      console.log("⚡ [HÍBRIDO] Actualización manual en vivo. Corriendo algoritmo espejo matemático.");
      let preciosSugeridos = {};

      periodoCompleto.forEach(f => {
        if (ocupadas[f]) {
          preciosSugeridos[f] = ocupadas[f]; // Prioridad absoluta: Fecha vendida se respeta
        } else {
          let p = new Date(f + 'T00:00:00');
          let diaSemana = p.getDay();
          let pts = scoreBaseDiasUser[diaSemana] !== undefined ? scoreBaseDiasUser[diaSemana] : 50;
          
          let precioBase = 300000 + ((pts / 100) * (700000 - 300000));
          if (configMesActual.pond_month_user === "Muy alta" || configMesActual.pond_month_user === "Alta") precioBase += 50000;
          if (configMesActual.pond_month_user === "Muy baja" || configMesActual.pond_month_user === "Baja") precioBase -= 30000;
          
          preciosSugeridos[f] = Math.round(Math.max(300000, Math.min(700000, precioBase)));
        }
      });

      // 🏆 CORRECCIÓN: El recálculo ahora también le regresa al Frontend los 12 meses reales de la BD
      return res.json({
        ponderacion_dias_user: scoreBaseDiasUser,
        ponderacion_dias_ia: scoreBaseDiasIA,
        estacionalidad_meses_completo_user: todosLosMesesBDUser,
        estacionalidad_meses_completo_ia: todosLosMesesBDIA,
        estacionalidad_periodo_user: configMesActual.pond_month_user,
        estacionalidad_periodo_ia: configMesActual.pond_month_ia,
        precios_sugeridos_calendario: preciosSugeridos,
        metodo: "Algoritmo Espejo Local (0s)"
      });
    }

    /* ----------------------------------------------------------------------
       📦 CAMINO B: INTENTAR LEER DESDE LA TABLA 'calendario' (CACHÉ DE LA BD)
       ---------------------------------------------------------------------- */
    const cacheBD = await pool.query(
      `SELECT TO_CHAR(fecha, 'YYYY-MM-DD') as fecha_iso, ia_price, holiday FROM calendario 
       WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha ASC`,
      [fecha_inicio, fecha_fin]
    );

    if (cacheBD.rows.length === periodoCompleto.length) {
      console.log("📦 [HÍBRIDO] Datos completos hallados en la tabla 'calendario'. 0s CPU.");
      let preciosCalendarioFinal = {};

      cacheBD.rows.forEach(row => {
        preciosCalendarioFinal[row.fecha_iso] = ocupadas[row.fecha_iso] ? ocupadas[row.fecha_iso] : Number(row.ia_price);
      });

      return res.json({
        ponderacion_dias_user: scoreBaseDiasUser,
        ponderacion_dias_ia: scoreBaseDiasIA,
        estacionalidad_meses_completo_user: todosLosMesesBDUser,
        estacionalidad_meses_completo_ia: todosLosMesesBDIA,
        estacionalidad_periodo_user: configMesActual.pond_month_user,
        estacionalidad_periodo_ia: configMesActual.pond_month_ia,
        precios_sugeridos_calendario: preciosCalendarioFinal,
        metodo: "Base de Datos (Caché Relacional)"
      });
    }

    /* ----------------------------------------------------------------------
       🤖 CAMINO C: EJECUTAR OLLAMA POR MICRO-LOTES CON PROMPT MAESTRO INTEGRADO
       ---------------------------------------------------------------------- */
    console.log(`🤖 [HÍBRIDO] Caché incompleta. Invocando Ollama por micro-lotes.`);
    const semanasSegmentadas = segmentarArreglo(periodoCompleto, 7);
    let preciosSugeridosCalendarioUnificado = {};
    let conteoEstacionalidadesIA = { "Muy alta": 0, "Alta": 0, "Media": 0, "Baja": 0, "Muy baja": 0 };

    for (let i = 0; i < semanasSegmentadas.length; i++) {
      const loteSemana = semanasSegmentadas[i];
      const historialSemanalFiltrado = registrosDB.rows.filter(h => loteSemana.includes(h.fecha));

      // Mapeo estructurado para alimentar las propiedades del Prompt Maestro
      let datosEntradaLote = loteSemana.map(fecha => {
        const fechaObj = new Date(fecha + 'T00:00:00');
        const diaSemana = fechaObj.getDay();
        let pondBase = scoreBaseDiasUser[diaSemana] !== undefined ? scoreBaseDiasUser[diaSemana] : 50;
        
        if (esFeriadoMexico(fecha)) {
          pondBase = (diaSemana >= 1 && diaSemana <= 4) ? 85 : 100;
        }

        return {
          fecha_solicitada: fecha,
          ponderacion_dia: pondBase,
          estacionalidad_mes: configMesActual.pond_month_user,
          historial_reservaciones: historialSemanalFiltrado.map(h => ({
            fecha_evento: h.fecha,
            precio_final: Number(h.precio_final),
            estatus: h.estatus
          }))
        };
      });

      // 🏆 PROMPT MAESTRO DE MERCADOTECNIA TOTALMENTE ENCAPSULADO
      const promptCorto = `=== 1. ROL ===
Buen día, necesito que me ayudes a asumir el rol de un estratega y experto senior en mercadotecnia con más de 15 años de trayectoria en el sector de hospitalidad y eventos sociales de gala de lujo. Tu especialidad es analizar y diseñar estrategias de precios y tarifas óptimas basadas en el valor percibido, la exclusividad del calendario y el comportamiento del consumidor local.

=== 2. CONTEXTO ===
=== Posicionamiento de Marca ===
El salón "Jardín Zibá", con sitio web oficial https://jardinziba.com/ y ubicado estratégicamente en La Galicia 0, Ahuatenco, Cuajimalpa de Morelos, 05039 Ciudad de México, CDMX, se posiciona en el mercado como un espacio exclusivo y premium de primer nivel. Al situarse en la prestigiosa zona de Cuajimalpa, muy cerca de los principales centros comerciales, hoteles de lujo y del clúster de negocios de Santa Fe, el recinto goza de un entorno único de alta gama que combina perfectamente elegancia, versatilidad y naturaleza. El jardín renta sus instalaciones en un rango de precios PREFERENTE que va desde los $300,000 MXN a los $700,000 MXN; sin embargo, este umbral no es definitivo ni limitante.

=== Lógica de Mercadotecnia para el Diseño de Precios ===
Debes entender que el diseño de la tarifa sugerida se rige mediante la “Ponderación del día” y la "Estacionalidad Mensual" que te envía el sistema, además de los días feriados oficiales en México considerados en la Ley Federal del Trabajo. Estas variables pueden comportarse bajo los siguientes criterios comerciales:

* Ponderación de Días (Escala 1-100 pts PREFERENTE): Mide el confort y la disposición estándar del consumidor para celebrar eventos premium. Esta distribución de pesos represents un escenario ideal, por lo que no debe considerarse definitiva ni estricta. En tu rol de experto de mercadotecnia estás facultado para ajustar la ponderación del día (mayor o menor puntaje) en función de la Estacionalidad Mensual o de las reservaciones realizadas en el mismo, entendiendo que un día de baja ponderación “preferente” puede adquirir un alto valor comercial si el inventario del mes se encuentra en su mayoría reservado. Los pesos preferentes están distribuidos IDEALMENTE de la siguiente manera:
  * Sábado (100 pts): Máxima deseabilidad.
  * Domingo (85 pts): Alta demanda familiar y eventos premium de día.
  * Viernes (70 pts): Demanda media-alta, ideal para eventos nocturnos corporativos.
  * Jueves (55 pts): Demanda moderada, inicio de la tendencia del fin de semana.
  * Miércoles (35 pts) y Martes (15 pts): Bajo volumen de reservaciones.
  * Lunes (0 pts): Mínimo deseo de compra.

* Estacionalidad Mensual (Categorías de Demanda del Mes): Clasifica la liquidez y el comportamiento del consumidor de la temporada en el mercado de eventos de gala en México. Esta clasificación representa un escenario ideal, por lo que no debe considerarse definitiva ni estricta. En tu rol de experto de mercadotecnia estás facultado para ajustar la clasificación de la Estacionalidad Mensual (mayor o menor demanda) en función de las reservaciones realizadas en el mismo, entendiendo que un mes de baja demanda puede adquirir una clasificación más alta si el inventario del mes se encuentra en su mayoría reservado. 
Los meses están clasificados IDEALMENTE de la siguiente manera:
  * Noviembre y Diciembre (ponderación: Muy Alta): Pico máximo de demanda debido a eventos corporativos de fin de año y fiestas de gala.
  * Mayo, Junio y Octubre (ponderación: Alta): Meses de alta deseabilidad por clima favorable, graduaciones y bodas de temporada.
  * Marzo, Abril y Julio (ponderación: Media): Demanda estable y equilibrada; comportamiento del consumidor predecible y tarifas estándar. 
  * Febrero y Agosto (ponderación: Baja): Se observa una contracción natural en el volumen de solicitudes debido al regreso de periodos vacacionales prolongados del segmento de alto nivel socioeconómico.
  * Enero y Septiembre (ponderación: Muy Baja): Meses de desaceleración social debido a la transición en el estilo de vida y recalibración de la agenda del consumidor de alta gama. 

* Días Feriados Oficiales en México (de acuerdo a la Ley Federal del Trabajo): Representan "Ocasiones Especiales" atípicas que disparan el deseo de celebración del mercado mexicano. Su diseño de valor rige de la siguiente manera:
  * Si el día feriado cae de Lunes a Jueves: La ponderación del día adquiere un valor preferente de 85 pts.
  * Si el día feriado cae de Viernes a Domingo: La ponderación del día adquiere un valor preferente de 100 pts.
  * Regla Crítica de Mercadotecnia: Siempre y cuando la fecha solicitada sea un día feriado, este puntaje (85 o 100 pts) reemplaza por completo la ponderación normal del día de la semana. El feriado neutraliza y sustituye al día común para evitar duplicar el puntaje.

=== Estado de Datos Actual ===
Las reservaciones del historial en la base de datos ya muestran precios reales entre los $300,000 MXN y los $700,000 MXN. Debes analizar estos datos desde un enfoque de mercadotecnia dual:
* Densidad y escasez: A menor disponibilidad de fechas libres en el mes, mayor es el deseo del consumidor y el costo de oportunidad, lo que justifica elevar el precio hacia el umbral superior o incluso superarlo.
* Validación de Tarifa (Anclaje): Revisa los precios de los eventos pasados en ese mismo mes o temporada. Utilízalos como referencia de validación comercial; si el mercado ya ha pagado tarifas premium en fechas similares, utilízalo como justificación para sostener un precio alto en la nueva cotización.

=== 3. ACCIONES ===
* Paso 1: Analiza la "Fecha Solicitada", lee su ponderación del día (de acuerdo a la escala de días o feriados), identifica su categoría de "Estacionalidad Mensual" e interpreta el volumen de ocupación del "historial de reservaciones reales" provisto por el sistema.
* Paso 2: Evalúa de manera crítica la escasez del inventario del mes. Si detectas anomalías de alta demanda en meses idealmente bajos (por ejemplo: múltiples fines de semana ya reservados en un mes catalogado como "Muy bajo" o "Bajo"), tienes la facultad de sugerir dinámicamente un incremento tanto en la ponderación del día como en la categoría estacional del mes, reflejando así la escasez real del mercado sobre los valores ideales teóricos.
* Paso 3: Correlaciona estas ponderaciones finales sugeridas con nuestro rango preferente de precios: una ponderación cercana a 10 combinada con un entorno mensual de demanda muy baja empujará la tarifa cerca del umbral inferior de $300,000 MXN; una ponderación del día cercana a 100 combinada con un entorno de demanda mensual muy alta justificará tarifas en el umbral superior de $700,000 MXN o más altas.
* Paso 4: Aplica el principio de anclaje de mercado revisando los precios finales reales del historial mensual para asegurar que tu nueva propuesta de tarifa sugerida sea competitiva, congruente y comercialmente validada y respaldada por lo que los clientes ya estuvieron dispuestos a pagar en esa misma temporada. 

=== 5. RESTRICCIÓN DE SALIDA ESTRICTA ===
Responde EXCLUSIVAMENTE con un objeto JSON plano, válido y perfectamente formateado, el cual debe contener la estructura unificada requerida para el calendario del sistema. No incluyas introducciones, saludos, comentarios explicativos o bloques de código markdown (\`\`\`json). Tu respuesta debe iniciar directamente con la llave de apertura "{".

=== ESTRUCTURA DE SALIDA REQUERIDA ===
{
  "ponderacion_dias_ia": { "0": 85, "1": 10, "2": 15, "3": 35, "4": 55, "5": 70, "6": 100 },
  "estacionalidad_periodo_ia": "Media",
  "precios_sugeridos_calendario": { "YYYY-MM-DD": 450000 }
}

=== DATOS DE LA SOLICITUD ACTUAL ===
Lote de procesamiento semanal indexado: ${JSON.stringify(datosEntradaLote)}`;

      const respuestaOllama = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODELO, 
          format: "json", 
          prompt: promptCorto, 
          stream: false,
          options: { temperature: 0.1, num_predict: 500 }
        })
      });

      if (respuestaOllama.ok) {
        const dataOllama = await respuestaOllama.json();
        const resultadoParcialIA = JSON.parse(dataOllama.response.trim());

        Object.assign(preciosSugeridosCalendarioUnificado, resultadoParcialIA.precios_sugeridos_calendario);

        if (resultadoParcialIA.estacionalidad_periodo_ia) {
          let cat = resultadoParcialIA.estacionalidad_periodo_ia;
          if (conteoEstacionalidadesIA[cat] !== undefined) conteoEstacionalidadesIA[cat]++;
        }

        // 💾 GUARDAR O ACTUALIZAR AUTOMÁTICAMENTE LA TABLA 'calendario' DÍA POR DÍA PARA EL FUTURO
        for (const fechaTexto of loteSemana) {
          const precioCalculadoIA = resultadoParcialIA.precios_sugeridos_calendario[fechaTexto] || 450000;
          const fechaObj = new Date(fechaTexto + 'T00:00:00');
          const idDay = fechaObj.getDay();
          const idMonth = fechaObj.getMonth() + 1;
          const idYear = fechaObj.getFullYear();

          if (resultadoParcialIA.ponderacion_dias_ia && resultadoParcialIA.ponderacion_dias_ia[idDay]) {
            await pool.query(
              `UPDATE ponderacion_dias SET pond_day_ia = $1 WHERE id_day = $2`,
              [resultadoParcialIA.ponderacion_dias_ia[idDay], idDay]
            );
          }

          await pool.query(
            `INSERT INTO calendario (fecha, id_day, id_month, id_year, ia_price, holiday)
             VALUES ($1, $2, $3, $4, $5, FALSE)
             ON CONFLICT (fecha) DO UPDATE SET ia_price = EXCLUDED.ia_price`,
            [fechaTexto, idDay, idMonth, idYear, precioCalculadoIA]
          );
        }
      }
    }

    // Calcular estacionalidad ganadora de la IA por votación de los bloques
    let estacionalidadIAGanadora = configMesActual.pond_month_ia;
    let maxVotos = -1;
    Object.keys(conteoEstacionalidadesIA).forEach(cat => {
      if (conteoEstacionalidadesIA[cat] > maxVotos && conteoEstacionalidadesIA[cat] > 0) {
        maxVotos = conteoEstacionalidadesIA[cat];
        estacionalidadIAGanadora = cat;
      }
    });

    // Actualizar tabla relacional de meses con el veredicto de la IA
    await pool.query(
      `UPDATE ponderacion_meses SET pond_month_ia = $1 WHERE id_month = $2`,
      [estacionalidadIAGanadora, mesRepresentativoId]
    );

    // Cruzar precios unificados finales contra ocupadas antes de enviar al Front
    let respuestaFinalPrecios = {};
    periodoCompleto.forEach(f => {
      respuestaFinalPrecios[f] = ocupadas[f] ? ocupadas[f] : (preciosSugeridosCalendarioUnificado[f] || 450000);
    });

    return res.json({
      ponderacion_dias_user: scoreBaseDiasUser,
      ponderacion_dias_ia: scoreBaseDiasIA,
      estacionalidad_meses_completo_user: todosLosMesesBDUser,
      estacionalidad_meses_completo_ia: todosLosMesesBDIA,
      estacionalidad_periodo_user: configMesActual.pond_month_user,
      estacionalidad_periodo_ia: estacionalidadIAGanadora,
      precios_sugeridos_calendario: respuestaFinalPrecios,
      metodo: "Cálculo en Vivo Ollama (Guardado en Tabla Calendario)"
    });

  } catch (error) {
    console.error("🔴 Error en el core del motor:", error.message);
    res.status(500).json({ error: "Error en el servidor de analíticas", detalle: error.message });
  }
});

/* ==========================================================================
   2. RUTAS DE ACTUALIZACIÓN MANUAL (VINCULADAS A TUS NUEVOS INPUTS DEL FRONT)
   ========================================================================== */

// Cambiar un parámetro de la Tabla 1 (Días)
app.put("/actualizar-ponderacion-dia", async (req, res) => {
  try {
    const { id_day, pond_day_user } = req.body;
    await pool.query(
      `UPDATE ponderacion_dias SET pond_day_user = $1 WHERE id_day = $2`,
      [pond_day_user, id_day]
    );
    res.json({ status: "Día actualizado en Postgres" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cambiar un parámetro de la Tabla 2 (Meses)
app.put("/actualizar-ponderacion-mes", async (req, res) => {
  try {
    const { id_month, pond_month_user } = req.body;
    await pool.query(
      `UPDATE ponderacion_meses SET pond_month_user = $1 WHERE id_month = $2`,
      [pond_month_user, id_month]
    );
    res.json({ status: "Mes actualizado en Postgres" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================================
   3. OPERACIONES ESTÁNDAR: RESERVACIONES (TABLA 'reservaciones')
   ========================================================================== */
app.get("/reservaciones", async (req, res) => {
  try {
    const result = await pool.query("SELECT id_reservation, TO_CHAR(fecha_evento, 'YYYY-MM-DD') as fecha_evento, precio_final, estatus FROM reservaciones ORDER BY fecha_evento ASC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener los registros" });
  }
});

app.post("/reservaciones", async (req, res) => {
  try {
    const { fecha_evento, precio_final, nombre_cliente } = req.body;
    if (!fecha_evento || !precio_final) return res.status(400).json({ error: "Faltan parámetros críticos" });

    const existe = await pool.query("SELECT * FROM reservaciones WHERE fecha_evento = $1 AND estatus = 'confirmado'", [fecha_evento]);
    if (existe.rows.length > 0) return res.status(400).json({ error: "Esta fecha ya cuenta con una reservación confirmada" });

    const result = await pool.query(
      `INSERT INTO reservaciones (fecha_evento, precio_final, estatus, nombre_cliente) VALUES ($1, $2, 'confirmado', $3) RETURNING *`,
      [fecha_evento, precio_final, nombre_cliente || "Cliente Gala"]
    );
    res.json({ mensaje: "¡Fecha bloqueada con éxito!", reservacion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Error al registrar reservación" });
  }
});

/* ==========================================================================
   4. RUTA DE AUDITORÍA RÁPIDA (TEST IA GENERATIVO)
   ========================================================================== */
app.get("/test-ia", async (req, res) => {
  const inicio = Date.now();
  const promptUltraOptimizado = `Calcula tarifas para el periodo ["2026-05-01"] usando score base {"6": 100}. Responde SOLO JSON plano: {"precios_sugeridos_calendario": {"2026-05-01": 650000}}`;

  try {
    const respuesta = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5:7b-instruct",
        format: "json",
        prompt: promptUltraOptimizado,
        stream: false,
        options: { temperature: 0.1, num_predict: 100 }
      })
    });

    const data = await respuesta.json();
    const segundos = ((Date.now() - inicio) / 1000).toFixed(2);
    res.json({ tiempo_ejecucion: `${segundos}s`, datos: JSON.parse(data.response.trim()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log("🚀 Servidor backend relacional corriendo en http://localhost:3000");
});