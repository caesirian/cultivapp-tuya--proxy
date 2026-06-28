// ─── CULTIVAPP – PROXY TUYA ───────────────────────────────────────────────────
// Servidor Express standalone – compatible con Railway, Render, cualquier VPS
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const crypto  = require("crypto");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CREDENCIALES TUYA ───────────────────────────────────────────────────────
const CLIENT_ID = "7u9rjgh5rchcvgxmxh3u";
const SECRET    = "dd134156b1f44653b941987477c81c78";
const BASE_HOST = "openapi.tuyacn.com";
const DEVICE_ID = "ebefb9fc12b7940a71l8gp";

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sign(str) {
  return crypto.createHmac("sha256", SECRET).update(str).digest("hex").toUpperCase();
}

function httpsGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE_HOST, path, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error("JSON parse error: " + data.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── MAPEO DE CÓDIGOS TUYA ───────────────────────────────────────────────────
const CODIGO_MAP = {
  va_temperature:     "tempAmb",
  temp_current:       "tempAmb",
  temperature:        "tempAmb",
  temp_indoor:        "tempAmb",
  va_humidity:        "humedad",
  humidity_value:     "humedad",
  humidity:           "humedad",
  hum_indoor:         "humedad",
  co2_value:          "co2",
  co2:                "co2",
  battery_percentage: "bateria",
  soil_temperature:   "tempMaceta",
  soil_humidity:      "humedadSuelo",
  bright_value:       "luz",
  illuminance:        "luz",
};
const TEMP_CODES = new Set([
  "va_temperature","temp_current","temperature","temp_indoor","soil_temperature"
]);

// ─── ENDPOINT PRINCIPAL ──────────────────────────────────────────────────────
app.get("/tuya", async (req, res) => {
  const deviceId = req.query.device || DEVICE_ID;

  try {
    // Paso 1: token
    const t1   = Date.now().toString();
    const tok  = await httpsGet("/v1.0/token?grant_type=1", {
      client_id: CLIENT_ID, sign: sign(CLIENT_ID + t1),
      t: t1, sign_method: "HMAC-SHA256"
    });

    if (!tok.success) return res.status(500).json({ error: "Token error", detail: tok });
    const accessToken = tok.result.access_token;

    // Paso 2: estado del dispositivo
    const t2  = Date.now().toString();
    const dev = await httpsGet(`/v1.0/devices/${deviceId}/status`, {
      client_id: CLIENT_ID, access_token: accessToken,
      sign: sign(CLIENT_ID + accessToken + t2),
      t: t2, sign_method: "HMAC-SHA256"
    });

    if (!dev.success) return res.status(500).json({ error: "Device error", detail: dev });

    // Paso 3: mapear valores
    const sensores = {};
    dev.result.forEach(item => {
      const nombre = CODIGO_MAP[item.code];
      let valor = item.value;
      if (TEMP_CODES.has(item.code) && typeof valor === "number") valor = valor / 10;
      if (nombre) sensores[nombre] = valor;
      sensores["_" + item.code] = item.value; // raw por si hay códigos nuevos
    });

    res.json({ ok: true, sensores, raw: dev.result });

  } catch(err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTHCHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "CultivApp Tuya Proxy OK" }));

app.listen(PORT, () => console.log(`Proxy Tuya corriendo en puerto ${PORT}`));
