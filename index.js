const express = require("express");
const crypto  = require("crypto");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const CLIENT_ID = "7u9rjgh5rchcvgxmxh3u";
const SECRET    = "dd134156b1f44653b941987477c81c78";
const BASE_HOST = "openapi.tuyaeu.com"; // Western Europe

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function httpsReq(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const opts = {
      hostname: BASE_HOST, path, method,
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); } });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function buildSign(clientId, secret, t, nonce, accessToken, method, path, body) {
  const contentHash = crypto.createHash("sha256").update(body ? JSON.stringify(body) : "").digest("hex");
  const strToSign   = [method, contentHash, "", path].join("\n");
  const signStr     = clientId + (accessToken || "") + t + nonce + strToSign;
  return crypto.createHmac("sha256", secret).update(signStr).digest("hex").toUpperCase();
}

async function getToken() {
  const t    = Date.now().toString();
  const n    = crypto.randomBytes(8).toString("hex");
  const path = "/v1.0/token?grant_type=1";
  const sig  = buildSign(CLIENT_ID, SECRET, t, n, "", "GET", path, null);
  const tok  = await httpsReq("GET", path, null, {
    "client_id": CLIENT_ID, "sign": sig, "t": t, "sign_method": "HMAC-SHA256", "nonce": n
  });
  if (!tok.success) throw new Error("Token error: " + JSON.stringify(tok));
  return tok.result.access_token;
}

// Mapeo códigos → nombres legibles
const CODIGO_MAP = {
  va_temperature:"tempAmb", temp_current:"tempAmb", temperature:"tempAmb", temp_indoor:"tempAmb",
  va_humidity:"humedad", humidity_value:"humedad", humidity:"humedad", hum_indoor:"humedad",
  co2_value:"co2", co2:"co2", battery_percentage:"bateria",
  switch:"encendido", switch_1:"encendido",
  countdown_1:"apagadoProgramadoSeg",
};
const TEMP_CODES = new Set(["va_temperature","temp_current","temperature","temp_indoor"]);

// GET /tuya?device=xxx — leer estado
app.get("/tuya", async (req, res) => {
  const deviceId = req.query.device;
  if (!deviceId) return res.status(400).json({ error: "Falta device" });
  try {
    const token = await getToken();
    const t2    = Date.now().toString();
    const n2    = crypto.randomBytes(8).toString("hex");
    const path2 = `/v1.0/devices/${deviceId}/status`;
    const sig2  = buildSign(CLIENT_ID, SECRET, t2, n2, token, "GET", path2, null);
    const dev   = await httpsReq("GET", path2, null, {
      "client_id": CLIENT_ID, "access_token": token,
      "sign": sig2, "t": t2, "sign_method": "HMAC-SHA256", "nonce": n2
    });
    if (!dev.success) return res.status(500).json({ error: "Device error", detail: dev });
    const sensores = {};
    dev.result.forEach(item => {
      let v = item.value;
      if (TEMP_CODES.has(item.code) && typeof v === "number") v = v / 10;
      const nombre = CODIGO_MAP[item.code];
      if (nombre) sensores[nombre] = v;
      sensores["_" + item.code] = item.value;
    });
    res.json({ ok: true, sensores, raw: dev.result });
  } catch(err) {
    console.error("GET /tuya error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /tuya/switch — encender/apagar switch
// body: { device: "xxx", on: true/false }
app.post("/tuya/switch", async (req, res) => {
  const { device, on } = req.body;
  if (!device) return res.status(400).json({ error: "Falta device" });
  try {
    const token  = await getToken();
    const t2     = Date.now().toString();
    const n2     = crypto.randomBytes(8).toString("hex");
    const path2  = `/v1.0/devices/${device}/commands`;
    // Intentar con "switch" primero, si falla usar "switch_1"
    const body   = { commands: [{ code: "switch", value: !!on }] };
    const sig2   = buildSign(CLIENT_ID, SECRET, t2, n2, token, "POST", path2, body);
    const result = await httpsReq("POST", path2, body, {
      "client_id": CLIENT_ID, "access_token": token,
      "sign": sig2, "t": t2, "sign_method": "HMAC-SHA256", "nonce": n2
    });
    if (!result.success) {
      // Reintentar con switch_1
      const t3    = Date.now().toString();
      const n3    = crypto.randomBytes(8).toString("hex");
      const body3 = { commands: [{ code: "switch_1", value: !!on }] };
      const sig3  = buildSign(CLIENT_ID, SECRET, t3, n3, token, "POST", path2, body3);
      const res3  = await httpsReq("POST", path2, body3, {
        "client_id": CLIENT_ID, "access_token": token,
        "sign": sig3, "t": t3, "sign_method": "HMAC-SHA256", "nonce": n3
      });
      return res.json({ ok: res3.success, result: res3 });
    }
    res.json({ ok: true, result });
  } catch(err) {
    console.error("POST /tuya/switch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "CultivApp Tuya Proxy OK", ts: Date.now() }));
app.listen(PORT, () => console.log(`Puerto ${PORT}`));
