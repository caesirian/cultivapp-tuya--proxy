const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const admin   = require("firebase-admin");

const app  = express();
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

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
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
function buildSign(clientId, secret, t, nonce, accessToken, method, path) {
  const contentHash = crypto.createHash("sha256").update("").digest("hex");
  const headers     = "";
  const url         = path;
  const strToSign   = [method, contentHash, headers, url].join("\n");
  const signStr     = clientId + (accessToken || "") + t + nonce + strToSign;
  return crypto.createHmac("sha256", secret).update(signStr).digest("hex").toUpperCase();
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

async function getToken() {
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
  return tok.result.access_token;
}

async function getDeviceStatus(deviceId, accessToken) {
  const t2    = Date.now().toString();
  const n2    = crypto.randomBytes(8).toString("hex");
  const path2 = `/v1.0/devices/${deviceId}/status`;
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

  const sensores = {};
  dev.result.forEach(item => {
    let v = item.value;
    if (TEMP_CODES.has(item.code) && typeof v === "number") v = v / 10;
    if (VOLT_CURR_CODES.has(item.code) && typeof v === "number") v = v / 10;
    const nombre = MAP[item.code];
    if (nombre) sensores[nombre] = v;
    sensores["_" + item.code] = item.value;
  });

  return { sensores, raw: dev.result };
}

// Un solo dispositivo: /tuya?device=luz_carpa  (o un ID crudo)
app.get("/tuya", async (req, res) => {
  const alias    = req.query.device;
  const deviceId = alias ? (DEVICES[alias] || alias) : DEVICE_ID;
  try {
    const accessToken = await getToken();
    const { sensores, raw } = await getDeviceStatus(deviceId, accessToken);
    res.json({ ok: true, sensores, raw });
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
        const { sensores, raw } = await getDeviceStatus(DEVICES[nombre], accessToken);
        return [nombre, { ok: true, id: DEVICES[nombre], sensores, raw }];
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
  const query = keys.map(k => `${k}=${encodeURIComponent(params[k])}`).join("&");
  return query ? `${basePath}?${query}` : basePath;
}

// Trae logs históricos de un dispositivo (v2.0 report-logs), paginando si hace falta.
// Gratis para los últimos 7 días, sin necesidad de suscripción paga adicional.
async function getRawHistory(deviceId, codes, startTime, endTime, accessToken, maxPages = 8) {
  let logs = [];
  let lastRowKey = "";
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
  }
  return logs;
}

// Escala el valor según el código (mismo criterio que el estado actual)
function scaleValue(code, rawValue) {
  const n = Number(rawValue);
  if (Number.isNaN(n)) return rawValue;
  if (TEMP_CODES.has(code) || VOLT_CURR_CODES.has(code)) return n / 10;
  return n;
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
      serie: puntos,
    };
  });
  return resultado;
}

// Histórico + estadísticas: /tuya/history?device=sensor_carpa&range=24h|7d&codes=va_temperature,va_humidity
app.get("/tuya/history", async (req, res) => {
  const alias    = req.query.device || "sensor_carpa";
  const deviceId = DEVICES[alias] || alias;
  const range    = req.query.range === "7d" ? "7d" : "24h";
  const codes    = req.query.codes || DEFAULT_HISTORY_CODES[alias] || "va_temperature,va_humidity";

  const endTime   = Date.now();
  const startTime = endTime - (range === "7d" ? 7 : 1) * 24 * 60 * 60 * 1000;

  try {
    const accessToken = await getToken();
    const logs = await getRawHistory(deviceId, codes, startTime, endTime, accessToken);
    const estadisticas = buildStats(logs);
    res.json({ ok: true, device: alias, deviceId, range, desde: startTime, hasta: endTime, estadisticas });
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
      getRawHistory(deviceId, codes, now - 24 * 60 * 60 * 1000, now, accessToken),
      getRawHistory(deviceId, codes, now - 7 * 24 * 60 * 60 * 1000, now, accessToken),
    ]);
    const { sensores: actual } = await getDeviceStatus(deviceId, accessToken);
    res.json({
      ok: true,
      device: alias,
      deviceId,
      actual,
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
        const [{ sensores: actual }, logs24h, logs7d] = await Promise.all([
          getDeviceStatus(deviceId, accessToken),
          getRawHistory(deviceId, codes, now - 24 * 60 * 60 * 1000, now, accessToken),
          getRawHistory(deviceId, codes, now - 7 * 24 * 60 * 60 * 1000, now, accessToken),
        ]);
        porLugar[lugar] = {
          ok: true,
          sensor: alias,
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
app.get("/tuya/devices", (req, res) => res.json({ ok: true, devices: DEVICES }));

// Guarda una lectura de los sensores de cultivo en Firestore.
// Estructura: lecturasSensores/{alias}/lecturas/{timestamp}  -> { ts, sensores }
async function snapshotYGuardar() {
  if (!db) throw new Error("Firestore no está configurado (falta FIREBASE_SERVICE_ACCOUNT_B64)");
  const accessToken = await getToken();
  const ts = Date.now();
  const nombres = DEVICES_CULTIVO.filter(n => DEVICES[n]);

  const resultados = await Promise.all(nombres.map(async (nombre) => {
    try {
      const { sensores } = await getDeviceStatus(DEVICES[nombre], accessToken);
      await db.collection("lecturasSensores").doc(nombre)
        .collection("lecturas").doc(String(ts))
        .set({ ts, sensores });
      return [nombre, { ok: true }];
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

app.listen(PORT, () => console.log(`Puerto ${PORT}`));
