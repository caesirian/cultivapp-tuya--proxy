const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const admin   = require("firebase-admin");

const app  = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const SNAPSHOT_SECRET = process.env.SNAPSHOT_SECRET || "";

// Firestore para guardar histórico propio (no depende del límite de 7 días de Tuya).
// La credencial va en base64 para evitar problemas de parseo de JSON en variables .env.
let db = null;
try {
  const svcB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (svcB64) {
    const svc = JSON.parse(Buffer.from(svcB64, "base64").toString("utf8"));
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    db = admin.firestore();
    console.log("Firestore conectado, proyecto:", svc.project_id);
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT_B64 no seteada — /tuya/snapshot no va a funcionar hasta configurarla.");
  }
} catch (e) {
  console.error("Error inicializando Firebase:", e.message);
}

const CLIENT_ID = process.env.TUYA_CLIENT_ID || "sg93tyvy53ds8tvs8cx4";
const SECRET    = process.env.TUYA_CLIENT_SECRET || "4b35f017cc554d689b846a7725666be3";
const BASE_HOST = process.env.TUYA_BASE_HOST || "openapi.tuyaus.com";
const DEVICE_ID = process.env.TUYA_DEVICE_ID || "ebefb9fc12b7940a71l8gp";

// Registro de todos los dispositivos del proyecto cloud (Western America DC).
// Los nombres coinciden con DISPOSITIVOS_TUYA en Caesirian/hgsys/cultivo/index.html
// para que el histórico se pueda asociar directamente a cada lugar de cultivo.
// Se pueden pisar/agregar vía env var TUYA_DEVICES_JSON (formato: {"nombre":"id",...})
const DEFAULT_DEVICES = {
  // Carpa
  sensor_carpa:     "ebefb9fc12b7940a71l8gp",
  luces_carpa:      "ebb60fa54c54559c63ysur",
  turbinas_carpa:   "3522204898f4abba2357",
  // Estructura 3x1
  sensor_3x1:       "eb8fc54c62a0049352pgax",
  luces_3x1:        "80210308a4cf12ac315b",
  // Dispositivos de la casa (no asociados a un lugar de cultivo)
  smart_plug:         "3522204898f4abba1fd6",
  aire_acondicionado: "eb97eb20b3f13e4819ciem",
  luz_sala_4:         "eb10b299b106db0bdcsbpx",
};
let DEVICES = DEFAULT_DEVICES;
if (process.env.TUYA_DEVICES_JSON) {
  try { DEVICES = { ...DEFAULT_DEVICES, ...JSON.parse(process.env.TUYA_DEVICES_JSON) }; }
  catch (e) { console.error("TUYA_DEVICES_JSON inválido, usando default:", e.message); }
}

// Dispositivos que son "lugares de cultivo" (para /tuya/snapshot y /tuya/history/resumen por defecto)
const DEVICES_CULTIVO = ["sensor_carpa", "luces_carpa", "turbinas_carpa", "sensor_3x1", "luces_3x1"];

// Metadata para exponer un catálogo completo en /tuya/devices (fuente única de verdad,
// el frontend la consume en vez de tener su propia copia hardcodeada de esto).
const DEVICE_META = {
  sensor_carpa:   { tipo: "sensor", nombre: "Sensor Carpa",   lugar: "Carpa" },
  luces_carpa:    { tipo: "switch", nombre: "Luces Carpa",    lugar: "Carpa" },
  turbinas_carpa: { tipo: "switch", nombre: "Turbinas Carpa", lugar: "Carpa" },
  sensor_3x1:     { tipo: "sensor", nombre: "Sensor 3x1",     lugar: "Estructura 3x1" },
  luces_3x1:      { tipo: "switch", nombre: "Luces 3x1",      lugar: "Estructura 3x1" },
};

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function httpsGet(path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname: BASE_HOST, path, method: "GET", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Firma según doc oficial Tuya v1.0
// string to sign = client_id + t + nonce + url (GET sin body)
function buildSign(clientId, secret, t, nonce, accessToken, method, path, body) {
  const bodyStr      = body ? JSON.stringify(body) : "";
  const contentHash  = crypto.createHash("sha256").update(bodyStr).digest("hex");
  const headers      = "";
  const url          = path;
  const strToSign    = [method, contentHash, headers, url].join("\n");
  const signStr      = clientId + (accessToken || "") + t + nonce + strToSign;
  return crypto.createHmac("sha256", secret).update(signStr).digest("hex").toUpperCase();
}

function httpsPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: BASE_HOST, path, method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

// Mapeo de códigos Tuya -> nombres amigables.
// Cubre sensores ambientales (ya en uso) y switches/plugs/consumo (para cuando
// se enciendan Smart Plug, Aire Acondicionado, Luz Sala 4, Luz carpa, turbina 1).
const TEMP_CODES = new Set(["va_temperature","temp_current","temperature","temp_indoor"]);
const POWER_CODES = new Set(["cur_power"]); // viene en W directo, sin dividir
const VOLT_CURR_CODES = new Set(["cur_voltage","cur_current"]); // /10
const MAP = {
  // Sensor ambiental (carpa)
  va_temperature:"tempAmb", temp_current:"tempAmb", temperature:"tempAmb", temp_indoor:"tempAmb",
  va_humidity:"humedad", humidity_value:"humedad", humidity:"humedad", hum_indoor:"humedad",
  co2_value:"co2", co2:"co2", battery_percentage:"bateria", battery_state:"bateriaEstado",
  // Switches / enchufes / luces
  switch:"encendido", switch_1:"encendido", switch_led:"encendido",
  // Consumo (Smart Plug, turbina)
  cur_power:"potenciaW", cur_voltage:"voltajeV", cur_current:"corrienteA",
  countdown_1:"apagadoProgramadoSeg",
};

let tokenCache = { accessToken: null, expiraEn: 0 };

async function getToken() {
  // Reusar token vigente (con 60s de margen) en vez de pedir uno nuevo en cada llamada.
  if (tokenCache.accessToken && Date.now() < tokenCache.expiraEn - 60000) {
    return tokenCache.accessToken;
  }

  const t1    = Date.now().toString();
  const n1    = crypto.randomBytes(8).toString("hex");
  const path1 = "/v1.0/token?grant_type=1";
  const sig1  = buildSign(CLIENT_ID, SECRET, t1, n1, "", "GET", path1);

  const tok = await httpsGet(path1, {
    "client_id":   CLIENT_ID,
    "sign":        sig1,
    "t":           t1,
    "sign_method": "HMAC-SHA256",
    "nonce":       n1,
  });

  if (!tok.success) throw Object.assign(new Error("Token error"), { detail: tok });
  tokenCache = {
    accessToken: tok.result.access_token,
    expiraEn: Date.now() + (tok.result.expire_time || 7200) * 1000,
  };
  return tokenCache.accessToken;
}

async function getDeviceStatus(deviceId, accessToken) {
  const t2    = Date.now().toString();
  const n2    = crypto.randomBytes(8).toString("hex");
  const path2 = `/v1.0/devices/${deviceId}`; // detalle del dispositivo: trae "online" + "status" juntos
  const sig2  = buildSign(CLIENT_ID, SECRET, t2, n2, accessToken, "GET", path2);

  const dev = await httpsGet(path2, {
    "client_id":    CLIENT_ID,
    "access_token": accessToken,
    "sign":         sig2,
    "t":            t2,
    "sign_method":  "HMAC-SHA256",
    "nonce":        n2,
  });

  if (!dev.success) throw Object.assign(new Error("Device error"), { detail: dev });

  const online     = !!dev.result.online;
  const statusList = dev.result.status || [];
  const sensores = {};
  statusList.forEach(item => {
    let v = item.value;
    if (TEMP_CODES.has(item.code) && typeof v === "number") v = v / 10;
    if (VOLT_CURR_CODES.has(item.code) && typeof v === "number") v = v / 10;
    const nombre = MAP[item.code];
    if (nombre) sensores[nombre] = v;
    sensores["_" + item.code] = item.value;
  });

  return { sensores, raw: statusList, online };
}

// Un solo dispositivo: /tuya?device=luz_carpa  (o un ID crudo)
app.get("/tuya", async (req, res) => {
  const alias    = req.query.device;
  const deviceId = alias ? (DEVICES[alias] || alias) : DEVICE_ID;
  try {
    const accessToken = await getToken();
    const { sensores, raw, online } = await getDeviceStatus(deviceId, accessToken);
    res.json({ ok: true, online, sensores, raw });
  } catch(err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Todos los dispositivos conocidos de una: /tuya/all
// No falla entero si alguno está offline/no disponible; lo marca por dispositivo.
app.get("/tuya/all", async (req, res) => {
  try {
    const accessToken = await getToken();
    const nombres = Object.keys(DEVICES);
    const resultados = await Promise.all(nombres.map(async (nombre) => {
      try {
        const { sensores, raw, online } = await getDeviceStatus(DEVICES[nombre], accessToken);
        return [nombre, { ok: true, id: DEVICES[nombre], online, sensores, raw }];
      } catch (err) {
        return [nombre, { ok: false, id: DEVICES[nombre], error: err.message, detail: err.detail }];
      }
    }));
    res.json({ ok: true, dispositivos: Object.fromEntries(resultados) });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Códigos por defecto a graficar/estadísticar (sensores de temp/humedad)
const DEFAULT_HISTORY_CODES = {
  sensor_carpa: "va_temperature,va_humidity",
  sensor_3x1:   "va_temperature,va_humidity",
};

// A qué lugar de cultivo pertenece cada sensor (coincide con DISPOSITIVOS_TUYA en index.html)
const LUGAR_POR_SENSOR = { sensor_carpa: "Carpa", sensor_3x1: "Estructura 3x1" };
const SENSORES_CULTIVO = Object.keys(LUGAR_POR_SENSOR);

// Construye path+query con params ordenados alfabéticamente (requisito de firma Tuya)
function buildQueryPath(basePath, params) {
  const keys = Object.keys(params).sort();
  const query = keys.map(k => `${k}=${params[k]}`).join("&");
  return query ? `${basePath}?${query}` : basePath;
}

// Trae logs históricos de un dispositivo (v2.0 report-logs), paginando si hace falta.
// Gratis para los últimos 7 días, sin necesidad de suscripción paga adicional.
async function getRawHistory(deviceId, codes, startTime, endTime, accessToken, maxPages = 8) {
  let logs = [];
  let lastRowKey = "";
  let truncado = false;
  for (let page = 0; page < maxPages; page++) {
    const params = { codes, end_time: String(endTime), size: "100", start_time: String(startTime) };
    if (lastRowKey) params.last_row_key = lastRowKey;
    const path = buildQueryPath(`/v2.0/cloud/thing/${deviceId}/report-logs`, params);
    const t = Date.now().toString();
    const n = crypto.randomBytes(8).toString("hex");
    const sig = buildSign(CLIENT_ID, SECRET, t, n, accessToken, "GET", path);

    const resp = await httpsGet(path, {
      "client_id":    CLIENT_ID,
      "access_token": accessToken,
      "sign":         sig,
      "t":            t,
      "sign_method":  "HMAC-SHA256",
      "nonce":        n,
    });

    if (!resp.success) throw Object.assign(new Error("History error"), { detail: resp });
    logs = logs.concat(resp.result.logs || []);
    if (!resp.result.has_more) break;
    lastRowKey = resp.result.last_row_key;
    if (page === maxPages - 1) truncado = true; // se llegó al límite de páginas y Tuya todavía tenía más datos
  }
  logs.truncado = truncado; // propiedad extra sobre el array, no afecta su uso normal
  return logs;
}

// Escala el valor según el código (mismo criterio que el estado actual)
function scaleValue(code, rawValue) {
  const n = Number(rawValue);
  if (Number.isNaN(n)) return rawValue;
  if (TEMP_CODES.has(code) || VOLT_CURR_CODES.has(code)) return n / 10;
  return n;
}

// Si la serie tiene muchísimos puntos (sensor que reporta muy seguido en un
// rango largo), la recorta de forma pareja para no mandarle al gráfico miles
// de puntos innecesarios. min/max/avg/count se calculan ANTES de esto, sobre
// los datos completos, así las estadísticas no pierden precisión.
function downsamplear(puntos, maxPuntos = 400) {
  if (puntos.length <= maxPuntos) return puntos;
  const paso = puntos.length / maxPuntos;
  const resultado = [];
  for (let i = 0; i < maxPuntos; i++) resultado.push(puntos[Math.floor(i * paso)]);
  return resultado;
}

// Arma serie de puntos {t, v} y estadísticas min/max/avg/count por código
function buildStats(logs) {
  const porCodigo = {};
  logs.forEach(item => {
    const nombre = MAP[item.code] || item.code;
    const valor = scaleValue(item.code, item.value);
    if (typeof valor !== "number") return; // omitimos series no numéricas (ej. switches) de las stats
    if (!porCodigo[nombre]) porCodigo[nombre] = [];
    porCodigo[nombre].push({ t: item.event_time, v: valor });
  });

  const resultado = {};
  Object.entries(porCodigo).forEach(([nombre, puntos]) => {
    puntos.sort((a, b) => a.t - b.t);
    const valores = puntos.map(p => p.v);
    resultado[nombre] = {
      min: Math.min(...valores),
      max: Math.max(...valores),
      avg: Number((valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(2)),
      count: valores.length,
      ultimo: valores[valores.length - 1],
      serie: downsamplear(puntos),
    };
  });
  return resultado;
}

// Histórico + estadísticas: /tuya/history?device=sensor_carpa&range=24h|7d&codes=va_temperature,va_humidity
app.get("/tuya/history", async (req, res) => {
  const alias    = req.query.device || "sensor_carpa";
  const deviceId = DEVICES[alias] || alias;
  const codes    = req.query.codes || DEFAULT_HISTORY_CODES[alias] || "va_temperature,va_humidity";
  const fecha    = req.query.fecha; // "YYYY-MM-DD", opcional: día puntual en huso Argentina (UTC-3)

  let startTime, endTime, range;
  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    // Medianoche a medianoche en Argentina (UTC-3), sin depender del huso del server
    startTime = new Date(`${fecha}T00:00:00-03:00`).getTime();
    endTime   = startTime + 24 * 60 * 60 * 1000;
    if (Number.isNaN(startTime)) return res.status(400).json({ error: "Fecha inválida" });
    endTime = Math.min(endTime, Date.now()); // no pedir a futuro
    range = "dia";
  } else {
    range     = req.query.range === "7d" ? "7d" : "24h";
    endTime   = Date.now();
    startTime = endTime - (range === "7d" ? 7 : 1) * 24 * 60 * 60 * 1000;
  }

  try {
    const accessToken = await getToken();
    const logs = await getRawHistory(deviceId, codes, startTime, endTime, accessToken);
    const estadisticas = buildStats(logs);
    res.json({ ok: true, device: alias, deviceId, range, fecha: fecha||null, desde: startTime, hasta: endTime, truncado: !!logs.truncado, estadisticas });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Histórico de 24h y 7d juntos en una sola llamada (como se ve en la app de Tuya)
app.get("/tuya/history/resumen", async (req, res) => {
  const alias    = req.query.device || "sensor_carpa";
  const deviceId = DEVICES[alias] || alias;
  const codes    = req.query.codes || DEFAULT_HISTORY_CODES[alias] || "va_temperature,va_humidity";
  const now      = Date.now();

  try {
    const accessToken = await getToken();
    const [logs24h, logs7d] = await Promise.all([
      getRawHistory(deviceId, codes, now - 24 * 60 * 60 * 1000, now, accessToken, 15),
      getRawHistory(deviceId, codes, now - 7 * 24 * 60 * 60 * 1000, now, accessToken, 45),
    ]);
    const { sensores: actual, online } = await getDeviceStatus(deviceId, accessToken);
    res.json({
      ok: true,
      device: alias,
      deviceId,
      online,
      actual,
      truncado: { "24h": !!logs24h.truncado, "7d": !!logs7d.truncado },
      historico: {
        "24h": buildStats(logs24h),
        "7d":  buildStats(logs7d),
      },
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Resumen agrupado por LUGAR: pensado para la vista "Lugares de cultivo".
// GET /tuya/cultivo/resumen -> { Carpa: {actual, historico:{24h,7d}}, "Estructura 3x1": {...} }
app.get("/tuya/cultivo/resumen", async (req, res) => {
  const now = Date.now();
  try {
    const accessToken = await getToken();
    const porLugar = {};
    await Promise.all(SENSORES_CULTIVO.map(async (alias) => {
      const deviceId = DEVICES[alias];
      const codes = DEFAULT_HISTORY_CODES[alias];
      const lugar = LUGAR_POR_SENSOR[alias];
      try {
        const [{ sensores: actual, online }, logs24h, logs7d] = await Promise.all([
          getDeviceStatus(deviceId, accessToken),
          getRawHistory(deviceId, codes, now - 24 * 60 * 60 * 1000, now, accessToken),
          getRawHistory(deviceId, codes, now - 7 * 24 * 60 * 60 * 1000, now, accessToken),
        ]);
        porLugar[lugar] = {
          ok: true,
          sensor: alias,
          online,
          actual,
          historico: { "24h": buildStats(logs24h), "7d": buildStats(logs7d) },
        };
      } catch (err) {
        porLugar[lugar] = { ok: false, sensor: alias, error: err.message };
      }
    }));
    res.json({ ok: true, lugares: porLugar });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Lista de dispositivos conocidos (nombre corto -> id)
// Calcula cuántas horas estuvo ENCENDIDO un switch durante un día calendario
// puntual (huso Argentina), integrando los eventos de encendido/apagado reales
// de Tuya (más preciso que asumir que nunca cambió entre lecturas periódicas).
async function calcularFotoperiodo(deviceId, fechaISO, accessToken) {
  const inicioDia = new Date(`${fechaISO}T00:00:00-03:00`).getTime();
  const finDia     = Math.min(inicioDia + 24 * 60 * 60 * 1000, Date.now());
  const margen     = 24 * 60 * 60 * 1000; // 24h de margen: cubre cualquier tramo encendido/apagado de hasta un dia completo

  const logs = await getRawHistory(deviceId, "switch,switch_1", inicioDia - margen, finDia, accessToken);
  const eventos = logs
    .map(l => ({ t: l.event_time, on: l.value === true || l.value === "true" }))
    .sort((a, b) => a.t - b.t);

  // Estado vigente justo antes del inicio del día (última lectura anterior a medianoche)
  let estadoInicial = false;
  for (const e of eventos) { if (e.t <= inicioDia) estadoInicial = e.on; else break; }

  let msEncendido = 0, tPrev = inicioDia, estadoPrev = estadoInicial;
  for (const e of eventos) {
    if (e.t <= inicioDia) continue;
    const tActual = Math.min(e.t, finDia);
    if (estadoPrev) msEncendido += tActual - tPrev;
    tPrev = tActual; estadoPrev = e.on;
    if (tPrev >= finDia) break;
  }
  if (tPrev < finDia && estadoPrev) msEncendido += finDia - tPrev;

  return {
    horasEncendido: +(msEncendido / 3600000).toFixed(2),
    horasVentana: +((finDia - inicioDia) / 3600000).toFixed(2),
    diaCompleto: finDia >= inicioDia + 24 * 60 * 60 * 1000,
    eventos: eventos.length,
  };
}

// GET /tuya/fotoperiodo?device=luces_carpa&fecha=YYYY-MM-DD (default: ayer, Argentina)
// Cuánto lleva encendida la luz AHORA MISMO (desde la última vez que pasó de
// apagada a encendida), comparado en tiempo real contra el objetivo del día —
// más intuitivo que esperar a que termine el día para saber si algo anda mal.
async function calcularSesionActual(deviceId, accessToken) {
  const ahora   = Date.now();
  const ventana = 30 * 60 * 60 * 1000; // 30h: cubre cualquier tramo on u off de hasta ~1 dia
  const [estado, logs] = await Promise.all([
    getDeviceStatus(deviceId, accessToken),
    getRawHistory(deviceId, "switch,switch_1", ahora - ventana, ahora, accessToken),
  ]);

  const eventos = logs
    .map(l => ({ t: l.event_time, on: l.value === true || l.value === "true" }))
    .sort((a, b) => a.t - b.t);

  const encendidoAhora = !!(estado.sensores && estado.sensores.encendido);
  if (!encendidoAhora) {
    return { online: estado.online, encendido: false, horasSesion: 0 };
  }

  // Retrocedemos buscando el inicio de la racha actual de "encendida"
  let inicioSesion = null;
  for (let i = eventos.length - 1; i >= 0; i--) {
    if (eventos[i].on) inicioSesion = eventos[i].t;
    else break;
  }
  if (inicioSesion === null) inicioSesion = ahora - ventana; // no vimos el inicio real, usamos el borde de la ventana

  return {
    online: estado.online,
    encendido: true,
    horasSesion: +((ahora - inicioSesion) / 3600000).toFixed(2),
  };
}

app.get("/tuya/fotoperiodo", async (req, res) => {
  const alias    = req.query.device;
  const deviceId = DEVICES[alias] || alias;
  if (!deviceId) return res.status(400).json({ error: "Falta 'device'" });

  let fecha = req.query.fecha;
  if (!fecha) {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000 - 3 * 60 * 60 * 1000);
    fecha = ayer.toISOString().slice(0, 10);
  }

  try {
    const accessToken = await getToken();
    const [resultado, sesionActual] = await Promise.all([
      calcularFotoperiodo(deviceId, fecha, accessToken),
      calcularSesionActual(deviceId, accessToken),
    ]);
    res.json({ ok: true, device: alias, deviceId, fecha, ...resultado, sesionActual });
  } catch (err) {
    console.error("Error fotoperiodo:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

app.get("/tuya/devices", (req, res) => {
  const devices = {};
  Object.keys(DEVICES).forEach(alias => {
    devices[alias] = { id: DEVICES[alias], ...(DEVICE_META[alias] || {}) };
  });
  res.json({ ok: true, devices });
});

// POST /tuya/switch  body: { device: "luces_carpa"|<id crudo>, on: true|false }
// Intenta con el código "switch" primero; si Tuya lo rechaza, reintenta con "switch_1"
// (distintos modelos de enchufe/interruptor usan uno u otro).
app.post("/tuya/switch", async (req, res) => {
  if (!SNAPSHOT_SECRET || req.body?.key !== SNAPSHOT_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { device, on } = req.body || {};
  if (!device || typeof on !== "boolean") {
    return res.status(400).json({ error: "Body inválido, se espera { device, on: true|false }" });
  }
  const deviceId = DEVICES[device] || device;
  const path = `/v1.0/devices/${deviceId}/commands`;

  async function intentar(codigo) {
    const accessToken = await getToken();
    const body = { commands: [{ code: codigo, value: on }] };
    const t = Date.now().toString();
    const n = crypto.randomBytes(8).toString("hex");
    const sig = buildSign(CLIENT_ID, SECRET, t, n, accessToken, "POST", path, body);
    return httpsPost(path, {
      "client_id": CLIENT_ID, "access_token": accessToken,
      "sign": sig, "t": t, "sign_method": "HMAC-SHA256", "nonce": n,
    }, body);
  }

  try {
    let resultado = await intentar("switch");
    if (!resultado.success) resultado = await intentar("switch_1");
    if (!resultado.success) return res.status(500).json({ error: "Switch error", detail: resultado });
    res.json({ ok: true, device, on, detail: resultado });
  } catch (err) {
    console.error("Error switch:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// Guarda una lectura de los sensores de cultivo en Firestore.
// Estructura: lecturasSensores/{alias}/lecturas/{timestamp}  -> { ts, sensores }
// Métricas numéricas que tiene sentido agregar (min/max/avg). Los switches
// (encendido true/false) no se promedian, quedan solo en el crudo.
const METRICAS_ROLLUP = ["tempAmb", "humedad"];

// Clave de hora/día en huso Argentina (UTC-3), lexicográficamente ordenable
// para poder hacer range-queries directo sobre el ID del documento.
function claveHora(ts) { return new Date(ts - 3*60*60*1000).toISOString().slice(0,13); } // "YYYY-MM-DDTHH"
function claveDia(ts)  { return new Date(ts - 3*60*60*1000).toISOString().slice(0,10); } // "YYYY-MM-DD"

// Suma la nueva lectura al rollup existente (min/max/sum/count) de forma atómica.
async function actualizarRollup(refDoc, ts, sensores) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(refDoc);
    const data = snap.exists ? snap.data() : {};
    data.desde = Math.min(data.desde ?? ts, ts);
    data.hasta = Math.max(data.hasta ?? ts, ts);
    METRICAS_ROLLUP.forEach(m => {
      const v = sensores[m];
      if (typeof v !== "number") return;
      const actual = data[m] || { min: v, max: v, sum: 0, count: 0 };
      actual.min   = Math.min(actual.min, v);
      actual.max   = Math.max(actual.max, v);
      actual.sum   = (actual.sum || 0) + v;
      actual.count = (actual.count || 0) + 1;
      data[m] = actual;
    });
    tx.set(refDoc, data);
  });
}

async function actualizarRollups(nombre, ts, sensores) {
  const base = db.collection("lecturasSensores").doc(nombre);
  await Promise.all([
    actualizarRollup(base.collection("rollupHoraria").doc(claveHora(ts)), ts, sensores),
    actualizarRollup(base.collection("rollupDiaria").doc(claveDia(ts)), ts, sensores),
  ]);
}

// Claves de bucket en huso Argentina (UTC-3), sin depender del huso del server.
function claveHoraART(ts)  { return new Date(ts - 3*60*60*1000).toISOString().slice(0,13); } // "YYYY-MM-DDTHH"
function claveDiaART(ts)   { return new Date(ts - 3*60*60*1000).toISOString().slice(0,10); }  // "YYYY-MM-DD"

// Actualiza (o crea) los buckets de rollup horario y diario con los campos
// numéricos de una lectura, usando transacciones para que sea seguro acumular
// min/max/sum/count aunque se dispare más de una vez casi al mismo tiempo.
async function actualizarRollup(alias, ts, sensores) {
  const campos = Object.entries(sensores).filter(([k, v]) => typeof v === "number" && !k.startsWith("_"));
  if (!campos.length) return;

  const niveles = [
    { coleccion: "rollupHoraria", clave: claveHoraART(ts) },
    { coleccion: "rollupDiaria",  clave: claveDiaART(ts) },
  ];

  for (const { coleccion, clave } of niveles) {
    const ref = db.collection("lecturasSensores").doc(alias).collection(coleccion).doc(clave);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { clave, metrics: {} };
      for (const [campo, valor] of campos) {
        const m = data.metrics[campo] || { min: valor, max: valor, sum: 0, count: 0 };
        m.min = Math.min(m.min, valor);
        m.max = Math.max(m.max, valor);
        m.sum = m.sum + valor;
        m.count = m.count + 1;
        data.metrics[campo] = m;
      }
      tx.set(ref, data);
    });
  }
}

// Borra lecturas crudas de más de N días (el detalle minuto a minuto de hace
// semanas no aporta nada que el rollup horario/diario no dé igual, y así no
// se acumula basura sin límite en la colección de detalle fino).
async function podarLecturasViejas(alias, diasRetencion = 14) {
  const corte = String(Date.now() - diasRetencion * 24 * 60 * 60 * 1000);
  const ref = db.collection("lecturasSensores").doc(alias).collection("lecturas");
  const snap = await ref.orderBy(admin.firestore.FieldPath.documentId()).endBefore(corte).limit(200).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

async function snapshotYGuardar() {
  if (!db) throw new Error("Firestore no está configurado (falta FIREBASE_SERVICE_ACCOUNT_B64)");
  const accessToken = await getToken();
  const ts = Date.now();
  const nombres = DEVICES_CULTIVO.filter(n => DEVICES[n]);

  const resultados = await Promise.all(nombres.map(async (nombre) => {
    try {
      const { sensores, online } = await getDeviceStatus(DEVICES[nombre], accessToken);
      await db.collection("lecturasSensores").doc(nombre)
        .collection("lecturas").doc(String(ts))
        .set({ ts, online, sensores });
      await actualizarRollup(nombre, ts, sensores);
      const podadas = await podarLecturasViejas(nombre).catch(() => 0);
      return [nombre, { ok: true, podadas }];
    } catch (err) {
      // Dispositivo offline u otro error puntual: no rompe el snapshot de los demás
      return [nombre, { ok: false, error: err.message }];
    }
  }));

  return { ts, dispositivos: Object.fromEntries(resultados) };
}

// Disparado cada 15 min por GitHub Actions (o el cron que uses).
// GET /tuya/snapshot?key=SNAPSHOT_SECRET
app.get("/tuya/snapshot", async (req, res) => {
  if (!SNAPSHOT_SECRET || req.query.key !== SNAPSHOT_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const resultado = await snapshotYGuardar();
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error("Error en snapshot:", err.message);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

app.get("/", (req, res) => res.json({ status: "CultivApp Tuya Proxy OK", ts: Date.now() }));

// GET /tuya/rollup?device=sensor_carpa&nivel=hora|dia&desde=2026-06-01&hasta=2026-07-01
// Lee el histórico propio (sin límite de 7 días) agregado por hora o por día.
app.get("/tuya/rollup", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore no configurado" });
  const alias = req.query.device;
  if (!alias) return res.status(400).json({ error: "Falta 'device'" });
  const nivel = req.query.nivel === "dia" ? "rollupDiaria" : "rollupHoraria";

  try {
    let q = db.collection("lecturasSensores").doc(alias).collection(nivel)
      .orderBy(admin.firestore.FieldPath.documentId());
    if (req.query.desde) q = q.startAt(req.query.desde);
    if (req.query.hasta) q = q.endAt(req.query.hasta);
    const snap = await q.get();
    const puntos = snap.docs.map(d => d.data());
    res.json({ ok: true, device: alias, nivel, puntos });
  } catch (err) {
    console.error("Error rollup:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /tuya/lecturas?device=sensor_carpa&desde=<ts ms>&hasta=<ts ms>
// Lee el detalle crudo propio (retenido ~14 días, ver podarLecturasViejas).
app.get("/tuya/lecturas", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore no configurado" });
  const alias = req.query.device;
  if (!alias) return res.status(400).json({ error: "Falta 'device'" });

  try {
    let q = db.collection("lecturasSensores").doc(alias).collection("lecturas")
      .orderBy(admin.firestore.FieldPath.documentId());
    if (req.query.desde) q = q.startAt(String(req.query.desde));
    if (req.query.hasta) q = q.endAt(String(req.query.hasta));
    const snap = await q.get();
    const puntos = snap.docs.map(d => d.data());
    res.json({ ok: true, device: alias, puntos });
  } catch (err) {
    console.error("Error lecturas:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Puerto ${PORT}`));
