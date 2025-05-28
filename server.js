const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');

// CORRECCIÓN EN LA IMPORTACIÓN:
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeInMemoryStore // Asegúrate que esté aquí como export nombrado
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const AUTH_FILE_PATH = './baileys_auth_info';

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

// Inicialización del store
let store = null;
try {
    store = makeInMemoryStore({}); // Aquí estaba el error
    // Cargar datos del store si existen
    if (fs.existsSync('./baileys_store.json')) {
        try {
            store.readFromFile('./baileys_store.json');
            console.log('Store de Baileys cargado desde archivo.');
        } catch (e) {
            console.warn('No se pudo cargar el archivo de store de Baileys, iniciando uno nuevo:', e.message);
        }
    }
    // Guardar periódicamente
    setInterval(() => {
        if (store) {
            store.writeToFile('./baileys_store.json');
        }
    }, 10_000);
} catch (e) {
    console.error("Error fatal inicializando makeInMemoryStore. La aplicación no puede continuar sin el store.", e);
    // Podrías decidir cerrar la aplicación si el store es crítico y no se puede inicializar
    // process.exit(1); 
    // O continuar sin el store, pero algunas funciones de Baileys podrían no funcionar como se espera.
    console.warn("Continuando sin el store en memoria. Algunas funcionalidades pueden estar limitadas.");
}


async function startBaileys(wsClient) {
    if (waSocketInstance) {
        console.log('Cerrando instancia de Baileys existente antes de crear una nueva...');
        try {
            await waSocketInstance.logout(); 
        } catch (e) {
            console.error("Error al cerrar instancia previa de Baileys:", e.message);
        }
        waSocketInstance = null;
        if (fs.existsSync(AUTH_FILE_PATH)) {
            fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
            console.log('Credenciales de autenticación anteriores eliminadas.');
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FILE_PATH);

    waSocketInstance = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        browser: Browsers.macOS('Desktop'), 
        logger: require('pino')({ level: 'silent' }) 
    });

    if (store) { // Solo enlazar si el store se inicializó correctamente
        store.bind(waSocketInstance.ev);
    } else {
        console.warn("El store no está disponible, no se puede enlazar eventos al store.");
    }


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
                if (fs.existsSync('./baileys_store.json')) { // También limpiar el store si se desloguea
                    fs.rmSync('./baileys_store.json', { force: true });
                    console.log('Archivo de store de Baileys eliminado debido a logout.');
                    // Re-inicializar el store vacío
                    if (typeof makeInMemoryStore === 'function') { // Chequeo adicional por si acaso
                        store = makeInMemoryStore({});
                    } else {
                        store = null; // Marcar como no disponible
                        console.error("makeInMemoryStore no está disponible para reiniciar el store tras logout.");
                    }
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
                waSocketInstance = null;
            } else {
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
}

// ... (el resto del archivo server.js sigue igual desde aquí)
// ... (pega el resto del server.js que te di anteriormente)
// ...

async function sendMessageWithRetry(jid, content, retries = 2) {
    if (!waSocketInstance) throw new Error("Baileys no está conectado.");
    try {
        return await waSocketInstance.sendMessage(jid, content);
    } catch (error) {
        console.error(`Error enviando mensaje a ${jid}: ${error.message}. Retries restantes: ${retries}`);
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2s antes de reintentar
            return sendMessageWithRetry(jid, content, retries - 1);
        } else {
            throw error; // Lanzar error después de los reintentos
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

    if (!waSocketInstance) {
        console.error('Intento de envío, pero Baileys no está inicializado.');
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error: WhatsApp no está conectado. Ve al paso 3.' } }));
            wsClient.send(JSON.stringify({ type: 'sending_stopped' })); // Detener el proceso en el frontend
        }
        isSendingProcessActive = false;
        return;
    }


    const contact = globalContacts[currentSendingIndex];
    const personalizedMessage = globalMessageTemplate
        .replace(/{nombre}/g, contact.name)
        .replace(/{numero}/g, `+${contact.number}`); // Para la preview, el envío necesita el JID

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
        console.error(`Falló el envío a ${contact.name} (${jid}): ${errorMsg}`);
    }

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'message_status', payload: { contact, status, error: errorMsg } }));
    }

    currentSendingIndex++;

    if (currentSendingIndex >= globalContacts.length) {
        messageSendingLoop(wsClient); // Llamar una última vez para finalizar
    } else {
        if (currentSendingIndex > 0 && currentSendingIndex % globalBatchSize === 0) {
            console.log(`Pausa por lote después de ${globalBatchSize} mensajes.`);
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                 wsClient.send(JSON.stringify({ type: 'batch_pause_notification', payload: { batchSize: globalBatchSize } }));
            }
            sendingLoopTimeout = setTimeout(() => messageSendingLoop(wsClient), 30000); // Pausa de 30s
        } else {
            sendingLoopTimeout = setTimeout(() => messageSendingLoop(wsClient), globalIntervalSeconds * 1000);
        }
    }
}


wss.on('connection', (ws) => {
    console.log('Cliente conectado a WebSocket');
    globalWsClient = ws; 
    ws.send(JSON.stringify({ type: 'info', payload: { message: 'Conectado al servidor WebSocket.' } }));

    if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN && waSocketInstance.user) { 
         console.log("Una sesión de Baileys ya está activa. Notificando al frontend.");
         ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya estaba conectado.' } }));
    } else if (fs.existsSync(AUTH_FILE_PATH)) {
        console.log("Se encontraron credenciales guardadas. Intentando reconectar Baileys...");
        startBaileys(ws).catch(err => {
            console.error("Error al intentar reconectar Baileys automáticamente:", err);
             ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error reconectando sesión guardada: ' + err.message } }));
        });
    }


    ws.on('message', async (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('Recibido del cliente:', parsedMessage.type, parsedMessage.payload ? JSON.stringify(parsedMessage.payload).substring(0,50)+'...' : '');

            switch (parsedMessage.type) {
                case 'get_initial_baileys_status': // El frontend pide el estado actual
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
                    if (!waSocketInstance || !waSocketInstance.user) { // Chequear que esté autenticado también
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
                            console.log("Logout de Baileys exitoso.");
                        } catch (e) {
                            console.error("Error durante el logout de Baileys:", e);
                             if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error al cerrar sesión: ' + e.message } }));
                             }
                        } finally {
                            // La limpieza de waSocketInstance y AUTH_FILE_PATH se hace en el evento 'connection.update' (loggedOut)
                            // Para asegurar, si el evento no se dispara por alguna razón:
                            if (waSocketInstance) waSocketInstance = null; 
                            if (fs.existsSync(AUTH_FILE_PATH)) {
                                fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                            }
                             if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'Sesión cerrada por el usuario.' } }));
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