/* ==========================================================================
   1. GLOBALES Y CONFIGURACIÓN DINÁMICA DE REVENUE MANAGEMENT
   ========================================================================== */
const fechaActual = new Date();
let anioActual = 2026; // Sincronizado al año en curso de la simulación
let mesActual = fechaActual.getMonth(); 
let reservacionesDB = [];
let estrategiaMesActualIA = null; 

// Instancia global para el manejo de Keycloak
let _instanciaKeycloak = null;

// Diccionarios para el control de ponderaciones desde Postgres
let puntosDiaPreferente = {};
let puntosDiaIA = {};
let estacionalidadMesesBase = {};
let estacionalidadMesesIA = {};

// Estado independiente de la tabla Pesos del Usuario
let pesosUsuario = {
  dias: "Medio",
  mes: "Medio",
  fechas_especiales: "Medio",
  fechas_reservadas: "Medio"
};

const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const nombresDiasCompletos = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

/* ==========================================================================
   2. KEYCLOAK & INICIALIZACIÓN PROTEGIDA (FLUJO CORE FIJO)
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  try {
    _instanciaKeycloak = new Keycloak({
      url: "https://auth.oeste.mx",
      realm: "ziba-calendario",
      clientId: "ziba-frontend"
    });

    _instanciaKeycloak.init({ 
      onLoad: "login-required",
      checkLoginIframe: false 
    }).then(auth => {
      if (!auth) {
        window.location.reload(); 
      } else {
        console.log("🔐 Autenticación exitosa con Keycloak.");
        iniciarDashboard();
      }
    }).catch(err => {
      console.warn("⚠️ Modo bypass de seguridad activado por fallo de conexión.", err);
      iniciarDashboard();
    });
  } catch (e) {
    console.warn("⚠️ Ejecutando en desarrollo local sin Keycloak.", e);
    iniciarDashboard();
  }
});

async function iniciarDashboard() {
  const monthSelector = document.getElementById("monthSelector");
  if (monthSelector) {
    monthSelector.innerHTML = "";
    nombresMeses.forEach((name, idx) => {
      const opt = document.createElement("option"); opt.value = idx; opt.innerText = name;
      if (idx === mesActual) opt.selected = true;
      monthSelector.appendChild(opt);
    });
  }

  const yearSelector = document.getElementById("yearSelector");
  if (yearSelector) {
    yearSelector.innerHTML = "";
    for (let y = 2025; y <= 2030; y++) {
      const opt = document.createElement("option"); opt.value = y; opt.innerText = y;
      if (y === anioActual) opt.selected = true;
      yearSelector.appendChild(opt);
    }
  }

  /* ==========================================================================
     🏆 INTEGRACIÓN DE LOGUEO DINÁMICO & EVENTOS DEL DROPDOWN DE PERFIL
     ========================================================================== */
  const txtNombre = document.getElementById("txtNombreUsuarioTopbar");
  if (txtNombre) {
    if (_instanciaKeycloak && _instanciaKeycloak.authenticated && _instanciaKeycloak.idTokenParsed) {
      const token = _instanciaKeycloak.idTokenParsed;
      txtNombre.innerText = token.preferred_username || "Usuario Ziba";
    } else {
      txtNombre.innerText = "Administrador Ziba";
    }
  }

  // Lógica interactiva para alternar el menú flotante (Toggle)
  const trigger = document.getElementById("perfilDropdownTrigger");
  const menu = document.getElementById("perfilDropdownMenu");
  
  if (trigger && menu) {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("show");
    });

    document.addEventListener("click", () => {
      menu.classList.remove("show");
    });
  }

  // Control oficial del Cierre de Sesión conectado a auth.oeste.mx
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_instanciaKeycloak && _instanciaKeycloak.authenticated) {
        console.log("Cerrando sesión de manera segura en auth.oeste.mx...");
        _instanciaKeycloak.logout({ redirectUri: window.location.origin });
      } else {
        alert("Sesión cerrada correctamente en ambiente local (Bypass de seguridad).");
      }
    });
  }

  // Cargar pesos del usuario guardados (si el backend los persiste)
  await cargarPesosUsuario();

  // Carga inicial conectando con el Backend Relacional
  await cargarEstrategiaMesCompletoConIA(false);
  generarGraficaHistoricaOcupacion();
}

/* ==========================================================================
   2B. TABLA PESOS DEL USUARIO — CARGA Y PERSISTENCIA INDEPENDIENTE
   ========================================================================== */

/**
 * Mapeo de valores de texto a clases CSS de semáforo.
 * Aplica tanto a los selectores de Pesos del Usuario como a los de Meses.
 */
const mapaClasesPesos = {
  "Muy alto":  "very-high",
  "Alto":      "high",
  "Medio":     "medio",
  "Bajo":      "low",
  "Muy bajo":  "very-low",
  // aliases para compatibilidad con tabla de meses
  "Muy alta":  "very-high",
  "Alta":      "high",
  "Media":     "medio",
  "Baja":      "low",
  "Muy baja":  "very-low"
};

/**
 * Intenta cargar los pesos del usuario desde el backend.
 * Si falla, mantiene los valores por defecto (Medio).
 */
async function cargarPesosUsuario() {
  try {
    const response = await fetch("http://localhost:3000/pesos-usuario");
    if (response.ok) {
      const data = await response.json();
      // Fusionar con valores por defecto si el backend devuelve datos parciales
      pesosUsuario = { ...pesosUsuario, ...data };
    }
  } catch (error) {
    console.warn("ℹ️ No se pudieron cargar los pesos del usuario desde el backend. Usando valores por defecto.", error);
  }

  // Sincronizar la UI con los valores cargados (o por defecto)
  sincronizarSelectoresPesosUsuario();
}

/**
 * Actualiza el estado visual de todos los selectores de la tabla Pesos del Usuario
 * para que reflejen los valores del objeto `pesosUsuario`.
 */
function sincronizarSelectoresPesosUsuario() {
  const selectores = document.querySelectorAll(".select-peso-usuario");
  selectores.forEach(sel => {
    const key = sel.dataset.pesoKey;
    if (pesosUsuario[key]) {
      sel.value = pesosUsuario[key];
      // Aplicar clase semáforo
      sel.className = "select-peso-usuario " + (mapaClasesPesos[pesosUsuario[key]] || "medio");
    }
  });
}

/**
 * Manejador del cambio en cualquier selector de la tabla Pesos del Usuario.
 * Actualiza el estado local, la clase semáforo en tiempo real y persiste en backend.
 * @param {HTMLSelectElement} selectEl 
 */
async function actualizarPesoUsuario(selectEl) {
  const key = selectEl.dataset.pesoKey;
  const val = selectEl.value;

  // 1. Actualizar estado local
  pesosUsuario[key] = val;

  // 2. Reactividad visual inmediata: cambiar clase semáforo
  selectEl.className = "select-peso-usuario " + (mapaClasesPesos[val] || "medio");

  // 3. Persistir en el backend (si está disponible)
  try {
    const response = await fetch("http://localhost:3000/pesos-usuario", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: val })
    });

    if (response.ok) {
      console.log(`💾 Peso del usuario guardado: ${key} -> ${val}`);
    }
  } catch (error) {
    // En desarrollo local sin backend, solo loguear
    console.warn(`ℹ️ Backend no disponible. Peso registrado solo en memoria: ${key} -> ${val}`);
  }
}

/* ==========================================================================
   3. CONECTOR CORE: HISTORIAL REAL + CONSULTA HÍBRIDA AL SERVIDOR
   ========================================================================== */
async function cargarEstrategiaMesCompletoConIA(esManual = false) {
  const primerDia = `${anioActual}-${String(mesActual + 1).padStart(2, '0')}-01`;
  const ultimoDia = `${anioActual}-${String(mesActual + 1).padStart(2, '0')}-${new Date(anioActual, mesActual + 1, 0).getDate()}`;

  try {
    const response = await fetch("http://localhost:3000/obtener-estrategia-periodo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha_inicio: primerDia,
        fecha_fin: ultimoDia,
        es_recalculo_manual: esManual
      })
    });

    const data = await response.json();
    
    puntosDiaPreferente = data.ponderacion_dias_user;
    puntosDiaIA = data.ponderacion_dias_ia;
    
    estacionalidadMesesBase[mesActual] = data.estacionalidad_periodo_user;
    estacionalidadMesesIA[mesActual] = data.estacionalidad_periodo_ia;

    estrategiaMesActualIA = data;

    renderizarConsolaParametros();
    renderizarCalendarioDinamico();

  } catch (error) {
    console.error("🔴 Error en la carga del periodo:", error);
  }
}

/* ==========================================================================
   4. RENDERIZACIÓN DE LAS TABLAS DEL DASHBOARD (TABLAS 1 Y 2)
   ========================================================================== */
function renderizarConsolaParametros() {
  const tbodyDiasBase = document.getElementById("tbodyDiasBase");
  const tbodyMesesBase = document.getElementById("tbodyMesesBase");

  const mapaClasesEstacionales = {
    "Muy alta": "very-high", "Alta": "high", "Media": "medio", "Baja": "low", "Muy baja": "very-low",
    "Muy alto": "very-high", "Alto": "high", "Medio": "medio", "Bajo": "low", "Muy bajo": "very-low"
  };

  const ordenDias = [1, 2, 3, 4, 5, 6, 0];
  if (tbodyDiasBase) {
    tbodyDiasBase.innerHTML = "";
    ordenDias.forEach(d => {
      const tr = document.createElement("tr");
      const scoreUser = puntosDiaPreferente[d] !== undefined ? puntosDiaPreferente[d] : 50;
      const scoreIA = puntosDiaIA[d] !== undefined ? puntosDiaIA[d] : "—";

      tr.innerHTML = `
        <td><strong>${nombresDiasCompletos[d]}</strong></td>
        <td><input type="number" class="input-table-cell" min="0" max="100" value="${scoreUser}" data-day="${d}" onchange="actualizarPuntosDiaLocal(this)"></td>
        <td style="color: var(--ai-blue); font-weight: bold;">${scoreIA}</td>
      `;
      tbodyDiasBase.appendChild(tr);
    });
  }

  if (tbodyMesesBase) {
    tbodyMesesBase.innerHTML = "";
    
    // Respaldo oficial analítico de Jardín Zibá
    const demandaDefectoMeses = ["Muy baja", "Baja", "Media", "Media", "Alta", "Alta", "Media", "Baja", "Muy baja", "Alta", "Muy alta", "Muy alta"];

    nombresMeses.forEach((m, idx) => {
      const tr = document.createElement("tr");
      
      const catActual = estacionalidadMesesBase[idx] || demandaDefectoMeses[idx];
      let catIA = estacionalidadMesesIA[idx] || catActual;
      
      const claseColorUser = mapaClasesEstacionales[catActual] || "medio";
      const claseColorIA = mapaClasesEstacionales[catIA] || "medio";

      tr.innerHTML = `
        <td><strong>${m}</strong></td>
        <td>
          <select class="select-mes-cell ${claseColorUser}" data-month="${idx + 1}" onchange="actualizarEstacionalidadMesLocal(this)">
            <option value="Muy alta" ${catActual === 'Muy alta' ? 'selected' : ''}>Muy Alta </option>
            <option value="Alta" ${catActual === 'Alta' ? 'selected' : ''}>Alta </option>
            <option value="Media" ${catActual === 'Media' ? 'selected' : ''}>Media </option>
            <option value="Baja" ${catActual === 'Baja' ? 'selected' : ''}>Baja </option>
            <option value="Muy baja" ${catActual === 'Muy baja' ? 'selected' : ''}>Muy Baja </option>
          </select>
        </td>
        <td>
          <div class="contenedor-badge-ia ${claseColorIA}">${catIA}</div>
        </td>
      `;
      tbodyMesesBase.appendChild(tr);
    });
  }
}

async function actualizarEstacionalidadMesLocal(selectEl) {
  const monthId = parseInt(selectEl.dataset.month);
  const val = selectEl.value;
  const idxMes = monthId - 1;

  const mapaClasesEstacionales = {
    "Muy alta": "very-high", "Alta": "high", "Media": "medio", "Baja": "low", "Muy baja": "very-low"
  };

  // 🏆 REACTIVIDAD EN VIVO: Removemos los colores viejos del select y aplicamos el nuevo al instante
  selectEl.className = "select-mes-cell " + (mapaClasesEstacionales[val] || "medio");

  estacionalidadMesesBase[idxMes] = val;
  estacionalidadMesesIA[idxMes] = val; 

  try {
    const response = await fetch("http://localhost:3000/actualizar-ponderacion-mes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_month: monthId, pond_month_user: val })
    });

    if (response.ok) {
      console.log(`💾 Guardado en Postgres: Mes ${monthId} -> ${val}`);
    }

    if (monthId === (mesActual + 1)) {
      await cargarEstrategiaMesCompletoConIA(true);
    } else {
      renderVisualOnly(); 
    }
  } catch (error) {
    console.error("Error al actualizar ponderación mensual:", error);
  }
}

/* ==========================================================================
   5. PERSISTENCIA DE CAMBIOS MANUALES A POSTGRES
   ========================================================================== */
async function actualizarPuntosDiaLocal(inputEl) {
  const day = parseInt(inputEl.dataset.day);
  const val = Math.min(100, Math.max(0, parseInt(inputEl.value) || 0));
  inputEl.value = val;

  try {
    await fetch("http://localhost:3000/actualizar-ponderacion-dia", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_day: day, pond_day_user: val })
    });
    await cargarEstrategiaMesCompletoConIA(true);
  } catch (error) {
    console.error("Error al actualizar puntos de día:", error);
  }
}

function renderVisualOnly() {
  renderizarConsolaParametros();
}

/* ==========================================================================
   6. RENDERIZACIÓN DEL CALENDARIO DINÁMICO & CÓMPUTO GLOBAL DE KPIS
   ========================================================================== */
async function renderizarCalendarioDinamico() {
  const calendarMonthTitle = document.getElementById("calendarMonthTitle");
  if (calendarMonthTitle) calendarMonthTitle.innerText = `${nombresMeses[mesActual]} ${anioActual}`;

  const container = document.getElementById("singleCalendarContainer");
  if (!container) return;
  container.innerHTML = "";

  ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"].forEach(d => {
    const cell = document.createElement("div"); cell.className = "day-name-header"; cell.innerText = d;
    container.appendChild(cell);
  });

  try {
    const response = await fetch("http://localhost:3000/reservaciones");
    reservacionesDB = await response.json();
  } catch (e) { console.warn("No se pudieron actualizar los registros core."); }

  const diaJS = new Date(anioActual, mesActual, 1).getDay();
  const celdasVacias = diaJS === 0 ? 6 : diaJS - 1; 
  const totalDiasMes = new Date(anioActual, mesActual + 1, 0).getDate();

  for (let i = 0; i < celdasVacias; i++) {
    const emptyCell = document.createElement("div"); emptyCell.className = "calendar-wrapper-empty";
    container.appendChild(emptyCell);
  }

  for (let d = 1; d <= totalDiasMes; d++) {
    const stringMes = String(mesActual + 1).padStart(2, '0');
    const fechaTextoIso = `${anioActual}-${stringMes}-${String(d).padStart(2, '0')}`;

    const reservaReal = reservacionesDB.find(r => r.fecha_evento === fechaTextoIso);
    const estaOcupado = !!reservaReal;

    let precioSugeridoIa = 450000;
    if (estrategiaMesActualIA && estrategiaMesActualIA.precios_sugeridos_calendario && estrategiaMesActualIA.precios_sugeridos_calendario[fechaTextoIso] !== undefined) {
      precioSugeridoIa = estrategiaMesActualIA.precios_sugeridos_calendario[fechaTextoIso];
    }

    const dayElement = document.createElement("div");
    dayElement.className = `day ${estaOcupado ? 'ocupado' : 'libre'}`;
    
    if (d === fechaActual.getDate() && mesActual === fechaActual.getMonth() && anioActual === fechaActual.getFullYear()) {
      dayElement.classList.add("today");
    }

    dayElement.innerHTML = `
      <span class="day-number">${d}</span>
      <div class="day-prices-container">
        <div class="price-row ia-price"><span>S:</span>$${(precioSugeridoIa / 1000).toFixed(0)}k</div>
        <div class="price-row real-price">
          <span>R:</span>${estaOcupado ? '$' + (parseFloat(reservaReal.precio_final) / 1000).toFixed(0) + 'k' : '—'}
        </div>
      </div>
    `;

    dayElement.addEventListener("click", () => {
      alert(`Fecha seleccionada: ${fechaTextoIso}\nPrecio Sugerido IA: $${precioSugeridoIa.toLocaleString()} MXN`);
    });

    container.appendChild(dayElement);
  }

  /* ----------------------------------------------------------------------
     📊 MOTOR DE ANALÍTICAS TOTALES E HISTÓRICAS (CÁLCULO DEL NEGOCIO REAL)
     ---------------------------------------------------------------------- */
  const totalReservacionesAbsoluto = reservacionesDB.length;
  const ingresosGlobalesReales = reservacionesDB.reduce((acumulado, r) => acumulado + (parseFloat(r.precio_final) || 0), 0);
  const porcentajeOcupacionAnual = ((totalReservacionesAbsoluto / 365) * 100).toFixed(1);

  if (document.getElementById("kpiReservaciones")) {
    document.getElementById("kpiReservaciones").innerText = totalReservacionesAbsoluto;
  }
  
  if (document.getElementById("kpiIngreso")) {
    document.getElementById("kpiIngreso").innerText = `$${ingresosGlobalesReales.toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} M.N.`;
  }
  
  if (document.getElementById("kpiOcupacion")) {
    document.getElementById("kpiOcupacion").innerText = `${porcentajeOcupacionAnual}%`;
  }
}

/* ==========================================================================
   7. CONTROLES DE NAVEGACIÓN DE LOS SELECTORES
   ========================================================================== */
async function navegarAnioBoton(valor) {
  anioActual = Math.min(2030, Math.max(2025, anioActual + valor));
  const el = document.getElementById("yearSelector"); if (el) el.value = anioActual;
  await cargarEstrategiaMesCompletoConIA(false);
}

async function navegarMes(valor) {
  mesActual += valor;
  if (mesActual > 11) { mesActual = 0; anioActual++; }
  else if (mesActual < 0) { mesActual = 11; anioActual--; }
  
  const mEl = document.getElementById("monthSelector"); if (mEl) mEl.value = mesActual;
  const yEl = document.getElementById("yearSelector"); if (yEl) yEl.value = anioActual;
  await cargarEstrategiaMesCompletoConIA(false);
}

async function actualizarCalendarioPorSelectores() {
  const mEl = document.getElementById("monthSelector"); if (mEl) mesActual = parseInt(mEl.value);
  const yEl = document.getElementById("yearSelector"); if (yEl) anioActual = parseInt(yEl.value);
  await cargarEstrategiaMesCompletoConIA(false);
}

function generarGraficaHistoricaOcupacion() {
  const chart = document.getElementById("chartBars"); if (!chart) return; chart.innerHTML = "";
  const mockData = [{ mes: "Ene", valor: 20 }, { mes: "Feb", valor: 35 }, { mes: "Mar", valor: 50 }, { mes: "Abr", valor: 55 }, { mes: "May", valor: 80 }, { mes: "Jun", valor: 85 }, { mes: "Jul", valor: 60 }, { mes: "Ago", valor: 40 }, { mes: "Sep", valor: 25 }, { mes: "Oct", valor: 75 }, { mes: "Nov", valor: 95 }, { mes: "Dic", valor: 100 }];
  mockData.forEach(item => {
    const wrapper = document.createElement("div"); wrapper.classList.add("chart-bar-wrapper");
    wrapper.innerHTML = `<div class="chart-value">${item.valor}%</div><div class="chart-bar" style="height:${item.valor * 1.3}px"></div><div class="chart-month">${item.mes}</div>`;
    chart.appendChild(wrapper);
  });
}