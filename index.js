const express = require("express");
const crypto  = require("crypto");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.TUYA_CLIENT_ID || "sg93tyvy53ds8tvs8cx4";
const SECRET    = process.env.TUYA_CLIENT_SECRET || "4b35f017cc554d689b846a7725666be3";
const BASE_HOST = process.env.TUYA_BASE_HOST || "openapi.tuyaus.com";
const DEVICE_ID = process.env.TUYA_DEVICE_ID || "ebefb9fc12b7940a71l8gp";

// Registro de todos los dispositivos del proyecto cloud (Western America DC).
// Se pueden pisar/agregar vía env var TUYA_DEVICES_JSON (formato: {"nombre":"id",...})
const DEFAULT_DEVICES = {
  sensor_carpa:        "ebefb9fc12b7940a71l8gp",
  smart_plug:           "3522204898f4abba1fd6",
  aire_acondicionado:   "eb97eb20b3f13e4819ciem",
  luz_sala_4:           "eb10b299b106db0bdcsbpx",
  luz_carpa:            "ebb60fa54c54559c63ysur",
  turbina_1:            "3522204898f4abba2357",
};
let DEVICES = DEFAULT_DEVICES;
if (process.env.TUYA_DEVICES_JSON) {
  try { DEVICES = { ...DEFAULT_DEVICES, ...JSON.parse(process.env.TUYA_DEVICES_JSON) }; }
  catch (e) { console.error("TUYA_DEVICES_JSON inválido, usando default:", e.message); }
}

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

// Lista de dispositivos conocidos (nombre corto -> id)
app.get("/tuya/devices", (req, res) => res.json({ ok: true, devices: DEVICES }));

app.get("/", (req, res) => res.json({ status: "CultivApp Tuya Proxy OK", ts: Date.now() }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));
