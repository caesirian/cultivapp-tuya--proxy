const express = require("express");
const crypto  = require("crypto");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.TUYA_CLIENT_ID || "sg93tyvy53ds8tvs8cx4";
const SECRET    = process.env.TUYA_CLIENT_SECRET || "4b35f017cc554d689b846a7725666be3";
const BASE_HOST = process.env.TUYA_BASE_HOST || "openapi.tuyaus.com";
const DEVICE_ID = process.env.TUYA_DEVICE_ID || "ebefb9fc12b7940a71l8gp";

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

app.get("/tuya", async (req, res) => {
  const deviceId = req.query.device || DEVICE_ID;
  try {
    // Paso 1: token
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

    if (!tok.success) return res.status(500).json({ error: "Token error", detail: tok });
    const accessToken = tok.result.access_token;

    // Paso 2: estado del dispositivo
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

    if (!dev.success) return res.status(500).json({ error: "Device error", detail: dev });

    // Mapeo de códigos
    const TEMP_CODES = new Set(["va_temperature","temp_current","temperature","temp_indoor"]);
    const MAP = {
      va_temperature:"tempAmb", temp_current:"tempAmb", temperature:"tempAmb", temp_indoor:"tempAmb",
      va_humidity:"humedad", humidity_value:"humedad", humidity:"humedad", hum_indoor:"humedad",
      co2_value:"co2", co2:"co2", battery_percentage:"bateria",
    };
    const sensores = {};
    dev.result.forEach(item => {
      let v = item.value;
      if (TEMP_CODES.has(item.code) && typeof v === "number") v = v / 10;
      const nombre = MAP[item.code];
      if (nombre) sensores[nombre] = v;
      sensores["_" + item.code] = item.value;
    });

    res.json({ ok: true, sensores, raw: dev.result });

  } catch(err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "CultivApp Tuya Proxy OK", ts: Date.now() }));

app.listen(PORT, () => console.log(`Puerto ${PORT}`));
