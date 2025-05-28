const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const P = require('pino'); // Importar Pino para el logger

// Importación principal de Baileys
const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
    // No intentamos importar makeInMemoryStore explícitamente aquí
} = baileys;


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const AUTH_FILE_PATH = './baileys_auth_info';
const STORE_FILE_PATH = './baileys_store.json'; // Para un store simple si Baileys lo crea internamente

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let waSocketInstance = null;
let globalWsClient = null;

let globalContacts = [];
let globalMessageTemplate = "";
let globalIntervalSeconds = 5;
let globalBatchSize = 20;
let currentSendingIndex = 0;
let sendingLoopTimeout = null;
let isSendingProcessActive = false;
let isSendingProcessPaused = false;

// Función getMessage requerida por la configuración de Baileys
// Para este ejemplo, será un stub. En una app real, buscarías el mensaje en tu DB.
const getMessage = async (key) => {
    // console.log(`getMessage llamado para la clave: ${key.id}`);
    // Aquí implementarías la lógica para buscar un mensaje guardado por su clave.
    // Si usaras un store en memoria más explícito, podrías buscarlo ahí.
    // Por ahora, retornamos undefined como si no se encontrara.
    return undefined;
}


async function startBaileys(wsClient) {
    if (waSocketInstance) {
        console.log('Cerrando instancia de Baileys existente...');
        try {
            await waSocketInstance.logout();
        } catch (e) {
            console.warn("Advertencia al cerrar instancia previa (podría ya estar cerrada):", e.message);
        }
        waSocketInstance = null;
    }
    // Limpiar siempre las credenciales y el store para un nuevo QR
    if (fs.existsSync(AUTH_FILE_PATH)) {
        fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
        console.log('Credenciales de autenticación anteriores eliminadas.');
    }
    if (fs.existsSync(STORE_FILE_PATH)) {
        fs.rmSync(STORE_FILE_PATH, { force: true });
        console.log('Archivo de store anterior eliminado.');
    }


    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FILE_PATH);

    waSocketInstance = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }), // Usar Pino importado
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true,
        shouldIgnoreJid: jid => jid && jid.includes('@broadcast'),
        getMessage: getMessage // Añadir la función getMessage
        // No se pasa `makeInMemoryStore` explícitamente
    });

    // Eventos de Baileys
    waSocketInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && wsClient && wsClient.readyState === WebSocket.OPEN) {
            console.log('QR recibido, enviando al frontend.');
            wsClient.send(JSON.stringify({ type: 'qr_code', payload: { qr } }));
        }

        if (connection === 'close') {
            const boomError = lastDisconnect?.error ? new Boom(lastDisconnect.error) : null;
            const statusCode = boomError?.output?.statusCode;
            let reason = 'Conexión cerrada. ';

            if (statusCode === DisconnectReason.loggedOut) {
                reason += 'Sesión cerrada (logged out). Deberás escanear el QR de nuevo.';
                if (fs.existsSync(AUTH_FILE_PATH)) {
                    fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                }
                if (fs.existsSync(STORE_FILE_PATH)) {
                    fs.rmSync(STORE_FILE_PATH, { force: true });
                }
                waSocketInstance = null;
            } else if (statusCode === DisconnectReason.connectionLost) {
                reason += 'Conexión perdida con el servidor.';
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                reason += 'Conexión reemplazada. Otra sesión se abrió.';
                waSocketInstance = null;
            } else if (statusCode === DisconnectReason.timedOut) {
                reason += 'Tiempo de conexión agotado.';
            } else if (statusCode === DisconnectReason.multideviceMismatch) {
                reason += 'Error de Multi-dispositivo. Por favor, escanea el QR de nuevo.';
                 if (fs.existsSync(AUTH_FILE_PATH)) {
                    fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                }
                 if (fs.existsSync(STORE_FILE_PATH)) {
                    fs.rmSync(STORE_FILE_PATH, { force: true });
                }
                waSocketInstance = null;
            } else if (statusCode === DisconnectReason.restartRequired) {
                reason += 'Reinicio requerido. Intentando reconectar Baileys...';
                console.log(reason);
                // No llamar a startBaileys aquí directamente para evitar bucles si el error persiste.
                // Dejar que el usuario lo haga manualmente.
            }
             else {
                reason += `Razón: ${lastDisconnect?.error?.message || statusCode || 'Desconocida'}.`;
            }
            console.log(reason);
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: reason } }));
            }
        }

        if (connection === 'open') {
            console.log('WhatsApp conectado exitosamente!');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp Conectado' } }));
            }
        }
    });

    waSocketInstance.ev.on('creds.update', saveCreds);

    // Si Baileys usa un store interno y lo escribe, podríamos intentar leerlo/escribirlo,
    // pero la documentación no es clara sobre esto si no se pasa un store explícito.
    // Por ahora, nos enfocamos en que la conexión y el envío funcionen.
}


// ... (El resto de server.js: sendMessageWithRetry, messageSendingLoop, wss.on('connection', ...), etc. permanece igual que en la respuesta anterior)
// ... (Asegúrate de copiar todo el resto del archivo `server.js` que te proporcioné en la respuesta anterior, 
//      desde la función `sendMessageWithRetry` hasta el final del archivo.)
async function sendMessageWithRetry(jid, content, retries = 2) {
    if (!waSocketInstance || !waSocketInstance.user) throw new Error("Baileys no está conectado o autenticado.");
    try {
        return await waSocketInstance.sendMessage(jid, content);
    } catch (error) {
        console.error(`Error enviando mensaje a ${jid}: ${error.message}. Retries restantes: ${retries}`);
        if (retries > 0 && error.output?.statusCode !== 404) { 
            await new Promise(resolve => setTimeout(resolve, 2000)); 
            return sendMessageWithRetry(jid, content, retries - 1);
        } else {
            throw error; 
        }
    }
}


async function messageSendingLoop(wsClient) {
    if (!isSendingProcessActive || isSendingProcessPaused || currentSendingIndex >= globalContacts.length) {
        if (isSendingProcessActive && currentSendingIndex >= globalContacts.length) {
            console.log('Todos los mensajes procesados.');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'sending_finished' }));
            }
            isSendingProcessActive = false;
        }
        return;
    }

    if (!waSocketInstance || !waSocketInstance.user) {
        console.error('Intento de envío, pero Baileys no está inicializado o autenticado.');
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error: WhatsApp no está conectado/autenticado. Ve al paso 3.' } }));
            wsClient.send(JSON.stringify({ type: 'sending_stopped' })); 
        }
        isSendingProcessActive = false;
        return;
    }


    const contact = globalContacts[currentSendingIndex];
    const personalizedMessage = globalMessageTemplate
        .replace(/{nombre}/g, contact.name)
        .replace(/{numero}/g, `+${contact.number}`); 

    const jid = `${contact.number}@s.whatsapp.net`;
    let status = 'failed';
    let errorMsg = 'Error desconocido';

    try {
        console.log(`Enviando mensaje a ${contact.name} (${jid})...`);        
        await sendMessageWithRetry(jid, { text: personalizedMessage });
        status = 'sent';
        errorMsg = null;
        console.log(`Mensaje enviado a ${contact.name} (${jid})`);
    } catch (error) {
        errorMsg = error.message;
        if (error.output?.statusCode === 404) {
            errorMsg = "Número no encontrado en WhatsApp.";
        }
        console.error(`Falló el envío a ${contact.name} (${jid}): ${errorMsg}`);
    }

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'message_status', payload: { contact, status, error: errorMsg } }));
    }

    currentSendingIndex++;

    if (currentSendingIndex >= globalContacts.length) {
        messageSendingLoop(wsClient); 
    } else {
        if (currentSendingIndex > 0 && currentSendingIndex % globalBatchSize === 0) {
            console.log(`Pausa por lote después de ${globalBatchSize} mensajes.`);
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                 wsClient.send(JSON.stringify({ type: 'batch_pause_notification', payload: { batchSize: globalBatchSize } }));
            }
            sendingLoopTimeout = setTimeout(() => messageSendingLoop(wsClient), 30000); 
        } else {
            sendingLoopTimeout = setTimeout(() => messageSendingLoop(wsClient), globalIntervalSeconds * 1000);
        }
    }
}


wss.on('connection', (ws) => {
    console.log('Cliente conectado a WebSocket');
    globalWsClient = ws; 
    ws.send(JSON.stringify({ type: 'info', payload: { message: 'Conectado al servidor WebSocket.' } }));

    setTimeout(() => { 
        if (ws.readyState === WebSocket.OPEN) {
            if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN && waSocketInstance.user ) { 
                console.log("Una sesión de Baileys ya está activa. Notificando al frontend.");
                ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya estaba conectado.' } }));
            } else if (fs.existsSync(AUTH_FILE_PATH)) {
                console.log("Se encontraron credenciales guardadas. El usuario puede solicitar QR si es necesario.");
                 ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'Credenciales guardadas encontradas. Solicita QR si es necesario.' } }));
            } else {
                 ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'WhatsApp no conectado. Solicita QR.' } }));
            }
        }
    }, 500);


    ws.on('message', async (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('Recibido del cliente:', parsedMessage.type, parsedMessage.payload ? JSON.stringify(parsedMessage.payload).substring(0,50)+'...' : '');

            switch (parsedMessage.type) {
                case 'get_initial_baileys_status': 
                    if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN && waSocketInstance.user ) {
                        ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya conectado.' } }));
                    } else {
                         ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'WhatsApp no conectado. Solicita QR.' } }));
                    }
                    break;
                case 'generate_qr_request':
                    console.log("Solicitud para generar QR/Iniciar Baileys...");
                    startBaileys(ws).catch(err => {
                        console.error("Error al iniciar Baileys:", err);
                        if (ws.readyState === WebSocket.OPEN) {
                           ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error iniciando WhatsApp: ' + err.message } }));
                        }
                    });
                    break;

                case 'start_sending_request':
                    if (!waSocketInstance || !waSocketInstance.user) { 
                        ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error: WhatsApp no está conectado o autenticado. Conecta primero.' } }));
                        return;
                    }
                    globalContacts = parsedMessage.payload.contacts;
                    globalMessageTemplate = parsedMessage.payload.messageTemplate;
                    globalIntervalSeconds = parseInt(parsedMessage.payload.intervalSeconds) || 5;
                    globalBatchSize = parseInt(parsedMessage.payload.batchSize) || 20;
                    
                    currentSendingIndex = 0;
                    isSendingProcessActive = true;
                    isSendingProcessPaused = false;

                    console.log(`Iniciando envío: ${globalContacts.length} contactos, intervalo ${globalIntervalSeconds}s, lote ${globalBatchSize}.`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'sending_started' }));
                    }
                    messageSendingLoop(ws);
                    break;
                
                case 'pause_sending_request':
                    if (isSendingProcessActive && !isSendingProcessPaused) {
                        isSendingProcessPaused = true;
                        clearTimeout(sendingLoopTimeout);
                        console.log("Envío pausado por el usuario.");
                        if (ws.readyState === WebSocket.OPEN) {
                           ws.send(JSON.stringify({ type: 'sending_paused' }));
                        }
                    }
                    break;

                case 'resume_sending_request':
                    if (isSendingProcessActive && isSendingProcessPaused) {
                        isSendingProcessPaused = false;
                        console.log("Envío reanudado por el usuario.");
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'sending_resumed' }));
                        }
                        messageSendingLoop(ws); 
                    }
                    break;

                case 'stop_sending_request':
                    isSendingProcessActive = false;
                    isSendingProcessPaused = false;
                    clearTimeout(sendingLoopTimeout);
                    console.log("Envío detenido por el usuario.");
                     if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'sending_stopped' }));
                     }
                    break;
                
                case 'reset_baileys_request': 
                    console.log("Solicitud para cerrar sesión de Baileys...");
                    if (waSocketInstance) {
                        try {
                            await waSocketInstance.logout(); 
                            console.log("Logout de Baileys solicitado.");
                        } catch (e) {
                            console.error("Error durante el logout de Baileys (podría ya estar cerrado):", e.message);
                             if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'Error al cerrar sesión. Intenta generar QR de nuevo.' } }));
                             }
                            if (waSocketInstance) waSocketInstance = null; 
                            if (fs.existsSync(AUTH_FILE_PATH)) {
                                fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                            }
                             if (fs.existsSync(STORE_FILE_PATH)) { 
                                fs.rmSync(STORE_FILE_PATH, { force: true });
                            }
                        }
                    } else {
                        console.log("No había sesión de Baileys activa para cerrar.");
                         if (ws.readyState === WebSocket.OPEN) {
                             ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'No había sesión activa.' } }));
                         }
                    }
                    isSendingProcessActive = false;
                    isSendingProcessPaused = false;
                    clearTimeout(sendingLoopTimeout);
                    break;
            }
        } catch (err) {
            console.error('Error procesando mensaje del cliente o JSON inválido:', err, message.toString());
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error interno del servidor al procesar su solicitud.' } }));
            }
        }
    });

    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
        if (ws === globalWsClient) {
            globalWsClient = null; 
        }
    });

    ws.on('error', (error) => {
        console.error('Error en WebSocket del cliente:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor WABot escuchando en http://localhost:${PORT}`);
});