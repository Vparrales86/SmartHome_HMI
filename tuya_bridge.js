const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'tuya_config.json');

// --- DEFAULT STATE / CACHE ---
let config = {
    mode: "mock",
    clientId: "",
    clientSecret: "",
    endpoint: "https://openapi.tuyaus.com",
    schema: ""
};

let tokenCache = {
    accessToken: "",
    refreshToken: "",
    expireTime: 0, // epoch ms
};

// Simplified local mock devices for fallback
let mockDevicesState = {
    "ebfc0dbec9868bd91fn21v": { id: "ebfc0dbec9868bd91fn21v", status: { on: false } },
    "eb7cf6af22271b7086dama": { id: "eb7cf6af22271b7086dama", status: { locked: true } },
    "eb6d23ecf9be9e3fd1aydl": { id: "eb6d23ecf9be9e3fd1aydl", status: { on: false } },
    "eb336cd31719ca0f66lqkg": { id: "eb336cd31719ca0f66lqkg", status: { on: false } },
    "eb9be77ecae3064837yxoz": { id: "eb9be77ecae3064837yxoz", status: { on: false } },
    "ebe3a2236d8fb41192cbkj": { id: "ebe3a2236d8fb41192cbkj", status: { on: false } },
    "eb026ce6b853f58504jjax": { id: "eb026ce6b853f58504jjax", status: { on: false } },
    "eb81eb213ea6311bc5f4x9": { id: "eb81eb213ea6311bc5f4x9", status: { on: false, temp: 22 } },
    "eb45fc166a2b021df7qd7c": { id: "eb45fc166a2b021df7qd7c", status: { on: true } },
    "eb8a029eac3849c00ao5lr": { id: "eb8a029eac3849c00ao5lr", status: { temp: 21.8, hum: 52 } },
    "eb4164efd22d7fd73ffg9j": { id: "eb4164efd22d7fd73ffg9j", status: { on: false } },
    "ebb8c6db4c4b3bb1eek3s": { id: "ebb8c6db4c4b3bb1eek3s", status: { on: false } },
    "ebd912733b8b495a291hfj": { id: "ebd912733b8b495a291hfj", status: { on: false } },
    "ebec82a43c5ca0b656c52g": { id: "ebec82a43c5ca0b656c52g", status: { on: false } },
    "ebcfafbca9ef2a314c5ziv": { id: "ebcfafbca9ef2a314c5ziv", status: { on: false } }
};

// --- UTILITY: LOAD & SAVE CONFIG ---
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            console.log("[CONFIG] Archivo de configuración de Tuya cargado.");
        } catch (e) {
            console.error("[CONFIG] Error leyendo configuración:", e.message);
        }
    }
}

function saveConfig(newConfig) {
    config = { ...config, ...newConfig };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf8');
    console.log("[CONFIG] Configuración guardada en archivo.");
}

// --- TUYA SIGNATURE V2 CORE ALGORITHM ---
function generateTuyaSignature(method, pathUrl, body = '', accessToken = '') {
    const t = Date.now().toString();
    const nonce = ''; // Optional nonce
    
    // Hash request body (or SHA256 of empty string)
    const contentSha = crypto.createHash('sha256').update(body).digest('hex');
    
    // Standard format for headers (empty lines for no custom headers)
    const headersStr = "";
    
    // StringToSign = Method + "\n" + Content-SHA256 + "\n" + Headers + "\n" + URL
    const stringToSign = `${method}\n${contentSha}\n${headersStr}\n${pathUrl}`;
    
    // SignStr = ClientID + AccessToken + Timestamp + Nonce + StringToSign
    const signStr = config.clientId + accessToken + t + nonce + stringToSign;
    
    // HMAC-SHA256 signature
    const signature = crypto.createHmac('sha256', config.clientSecret)
                            .update(signStr)
                            .digest('hex')
                            .toUpperCase();
                            
    return {
        signature,
        t,
        nonce
    };
}

// --- NETWORK UTILITY: HTTPS REQUEST TO TUYA API ---
function makeTuyaRequest(method, pathUrl, bodyData = '', useToken = true) {
    return new Promise((resolve, reject) => {
        if (!config.clientId || !config.clientSecret) {
            return reject(new Error("Tuya ClientID o ClientSecret no configurados."));
        }

        // Get accessToken if required
        const tokenPromise = useToken ? getAccessToken() : Promise.resolve('');

        tokenPromise.then(token => {
            const { signature, t } = generateTuyaSignature(method, pathUrl, bodyData, token);
            
            // Clean host from URL
            const urlObj = new URL(config.endpoint);
            const options = {
                hostname: urlObj.hostname,
                port: 443,
                path: pathUrl,
                method: method,
                headers: {
                    'client_id': config.clientId,
                    'sign': signature,
                    't': t,
                    'sign_method': 'HMAC-SHA256',
                    'Content-Type': 'application/json'
                }
            };

            if (token) {
                options.headers['access_token'] = token;
            }

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.success) {
                            resolve(parsed.result);
                        } else {
                            reject(new Error(`Tuya API Error: Code ${parsed.code} - ${parsed.msg}`));
                        }
                    } catch (e) {
                        reject(new Error(`Respuesta inválida de Tuya: ${data}`));
                    }
                });
            });

            req.on('error', err => reject(err));
            
            if (bodyData) {
                req.write(bodyData);
            }
            req.end();
        }).catch(reject);
    });
}

// --- GET AND REFRESH ACCESS TOKEN ---
function getAccessToken() {
    // If we have a cached valid token, return it
    if (tokenCache.accessToken && tokenCache.expireTime > Date.now()) {
        return Promise.resolve(tokenCache.accessToken);
    }

    console.log("[TUYA] Solicitando nuevo Access Token...");
    const pathUrl = "/v1.0/token?grant_type=1"; // grant_type=1 is Developer Credential Login
    
    return makeTuyaRequest("GET", pathUrl, '', false).then(result => {
        tokenCache.accessToken = result.access_token;
        tokenCache.refreshToken = result.refresh_token;
        // Token typically expires in 7200 seconds. Save expiry minus 5 minutes safety cushion
        tokenCache.expireTime = Date.now() + (result.expire_time * 1000) - (5 * 60 * 1000);
        console.log("[TUYA] Token de acceso obtenido con éxito. Vence en (minutos):", Math.round(result.expire_time / 60));
        return tokenCache.accessToken;
    });
}

// --- HTTP SERVER HANDLERS ---
const server = http.createServer((req, res) => {
    // Enable CORS for frontend local file access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    console.log(`[HTTP] ${req.method} ${req.url}`);

    // Endpoint: Status of the bridge
    if (req.url === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: "online", 
            mode: config.mode,
            hasCredentials: !!(config.clientId && config.clientSecret)
        }));
        return;
    }

    // Endpoint: Configure bridge credentials
    if (req.url === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const newConfig = JSON.parse(body);
                saveConfig(newConfig);
                // Clear cached token on credential change
                tokenCache = { accessToken: "", refreshToken: "", expireTime: 0 };
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, mode: config.mode }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Endpoint: Get status list of devices
    if (req.url === '/api/devices' && req.method === 'GET') {
        if (config.mode === 'mock' || !config.clientId) {
            // Mock mode fallback response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.values(mockDevicesState)));
            return;
        }

        // Live Mode: Request actual device lists from Tuya
        // We will fetch statuses in parallel for the devices
        const deviceIds = Object.keys(mockDevicesState);
        const statusRequests = deviceIds.map(id => {
            return makeTuyaRequest("GET", `/v1.0/devices/${id}/status`).then(result => {
                // Map Tuya DPs to HMI frontend state
                const mappedStatus = parseTuyaDps(result);
                return { id, status: mappedStatus };
            }).catch(err => {
                console.error(`[TUYA] Error leyendo estado de device ${id}:`, err.message);
                // Fallback to local mock state if single fetch fails
                return mockDevicesState[id];
            });
        });

        Promise.all(statusRequests).then(results => {
            // Update local mock state caches
            results.forEach(resObj => {
                if (resObj) mockDevicesState[resObj.id] = resObj;
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        });
        return;
    }

    // Endpoint: Send command to a device
    const commandMatch = req.url.match(/^\/api\/device\/([a-zA-Z0-9]+)\/command$/);
    if (commandMatch && req.method === 'POST') {
        const deviceId = commandMatch[1];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const cmdPayload = JSON.parse(body); // e.g. { command: 'on', value: true }
                console.log(`[COMMAND] Enviar a ${deviceId}:`, cmdPayload);

                // Update local mock state immediately
                if (mockDevicesState[deviceId]) {
                    const dev = mockDevicesState[deviceId];
                    if (cmdPayload.command === 'on') dev.status.on = cmdPayload.value;
                    if (cmdPayload.command === 'locked') dev.status.locked = cmdPayload.value;
                    if (cmdPayload.command === 'temp') dev.status.temp = cmdPayload.value;
                }

                if (config.mode === 'mock' || !config.clientId) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, msg: "Simulado en Mock Mode" }));
                    return;
                }

                // Translate HMI command to Tuya DP codes
                const tuyaCommands = buildTuyaCommands(deviceId, cmdPayload);
                const pathUrl = `/v1.0/devices/${deviceId}/commands`;
                const requestBody = JSON.stringify({ commands: tuyaCommands });

                makeTuyaRequest("POST", pathUrl, requestBody).then(result => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, tuyaResult: result }));
                }).catch(err => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                });

            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // Default 404 Route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Ruta no encontrada" }));
});

// --- PARSER: TUYA DP ARRAY TO LOCAL STATUS OBJECT ---
function parseTuyaDps(statusArray) {
    let result = {};
    if (!Array.isArray(statusArray)) return result;

    statusArray.forEach(dp => {
        const code = dp.code;
        const val = dp.value;

        // Map standard light toggles (e.g. switch_led, switch_1)
        if (code === 'switch_led' || code === 'switch_1' || code === 'switch' || code === 'switch_2') {
            result.on = !!val;
        }
        // Map smartlocks
        else if (code === 'lock_motor_state' || code === 'closed') {
            result.locked = (val === 'lock' || val === true || val === 'closed');
        }
        // Map Air Conditioner Temperature Sets
        else if (code === 'temp_set') {
            result.temp = parseInt(val);
        }
        // Map Temperature & Humidity sensors
        else if (code === 'va_temperature' || code === 'temp_current') {
            result.temp = typeof val === 'number' ? (val > 100 ? val / 10 : val) : parseFloat(val);
        }
        else if (code === 'va_humidity' || code === 'humidity_value') {
            result.hum = parseInt(val);
        }
    });

    return result;
}

// --- COMMAND BUILDER: TRANSLATE HMI COMMAND TO TUYA DP FORMAT ---
function buildTuyaCommands(deviceId, cmdPayload) {
    const code = cmdPayload.command;
    const val = cmdPayload.value;
    
    // Depending on device profiles we map HMI variables to typical Tuya DP codes
    if (deviceId === "ebfc0dbec9868bd91fn21v" || deviceId === "eb9be77ecae3064837yxoz" || 
        deviceId === "eb4164efd22d7fd73ffg9j" || deviceId === "ebd912733b8b495a291hfj" || 
        deviceId === "ebec82a43c5ca0b656c52g" || deviceId === "ebcfafbca9ef2a314c5ziv") {
        // Simple/double switches mapping to switch_1
        return [{ code: "switch_1", value: val }];
    } else if (deviceId === "eb6d23ecf9be9e3fd1aydl" || deviceId === "ebb8c6db4c4b3bb1eek3s") {
        // Multi-gang switches (toggle all gangs or primary gangs)
        return [
            { code: "switch_1", value: val }, 
            { code: "switch_2", value: val },
            { code: "switch_3", value: val }
        ];
    } else if (deviceId === "eb7cf6af22271b7086dama") {
        // Lock command
        return [{ code: "closed", value: val }];
    } else if (deviceId === "eb81eb213ea6311bc5f4x9") {
        // Air conditioner
        if (code === 'on') {
            return [{ code: "switch", value: val }];
        } else if (code === 'temp') {
            return [{ code: "temp_set", value: val }];
        }
    } else {
        // Default generic switch command fallback
        return [{ code: "switch", value: val }];
    }
}

// --- SERVER START ---
loadConfig();
server.listen(PORT, () => {
    console.log(`==================================================================`);
    console.log(`  Tuya Smart Life HMI Proxy Bridge funcionando en puerto ${PORT}`);
    console.log(`  Modo actual: ${config.mode.toUpperCase()}`);
    console.log(`  Visualiza el HMI abriendo el archivo index.html en tu navegador.`);
    console.log(`==================================================================`);
});
