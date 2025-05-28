const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const P = require('pino');

const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = baileys;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000; // Render usa 10000 a veces, pero process.env.PORT es lo correcto
const AUTH_DIR = './baileys_auth_info'; // Directorio para credenciales
const STORE_FILE = './baileys_store.json'; // Archivo de store que Baileys podría usar

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let waSocketInstance = null;
let globalWsClient = null; // Cliente WebSocket activo para enviar actualizaciones

// Variables de envío
let globalContacts = [];
let globalMessageTemplate = "";
let globalIntervalSeconds = 5;
let globalBatchSize = 20;
let currentSendingIndex = 0;
let sendingLoopTimeout = null;
let isSendingProcessActive = false;
let isSendingProcessPaused = false;

// Función getMessage requerida por Baileys
const getMessage = async (key) => {
    // console.log(`getMessage llamado para: ${key.id}`);
    // En una implementación real, buscarías en tu base de datos de mensajes.
    // Para envío masivo simple, si no necesitamos reintentar mensajes complejos, esto es suficiente.
    return undefined;
};

async function cleanupSessionFiles() {
    console.log("Limpiando archivos de sesión (auth y store)...");
    if (fs.existsSync(AUTH_DIR)) {
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log(`Directorio de autenticación eliminado: ${AUTH_DIR}`);
        } catch (e) {
            console.error(`Error eliminando directorio de autenticación ${AUTH_DIR}:`, e.message);
        }
    }
    if (fs.existsSync(STORE_FILE)) {
        try {
            fs.rmSync(STORE_FILE, { force: true });
            console.log(`Archivo de store eliminado: ${STORE_FILE}`);
        } catch (e) {
            console.error(`Error eliminando archivo de store ${STORE_FILE}:`, e.message);
        }
    }
}

async function killExistingSocket() {
    if (waSocketInstance) {
        console.log("Intentando cerrar socket de Baileys existente...");
        try {
            // Forzar el cierre de la conexión WebSocket subyacente si existe
            if (waSocketInstance.ws && typeof waSocketInstance.ws.close === 'function') {
                waSocketInstance.ws.close();
            }
            // Finalizar la instancia de Baileys (esto puede o no ser necesario después de cerrar el ws)
            // y puede fallar si la conexión ya está mal, por eso el try-catch.
            await waSocketInstance.end(new Boom('Nueva conexión solicitada', { statusCode: DisconnectReason.connectionReplaced }));
            console.log("Socket de Baileys anterior finalizado/cerrado.");
        } catch (e) {
            console.warn("Advertencia al finalizar/cerrar socket de Baileys anterior:", e.message);
        }
        waSocketInstance = null;
    }
}


async function startBaileys(wsClient) {
    await killExistingSocket(); // Primero intenta cerrar cualquier socket activo
    await cleanupSessionFiles(); // Luego limpia los archivos

    console.log("Iniciando nueva instancia de Baileys...");
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    try {
        waSocketInstance = makeWASocket({
            auth: state,
            logger: P({ level: 'silent' }), // Puedes cambiar a 'debug' para logs detallados de Baileys
            browser: Browsers.macOS('Desktop'), // Simula ser un navegador de escritorio
            getMessage: getMessage, // Requerido
            // Considerar estas opciones para estabilidad, aunque la documentación no las fuerza:
            // syncFullHistory: true, // Sincroniza todo el historial, puede consumir más al inicio
            // printQRInTerminal: false, // Ya lo tenemos, pero por si acaso
            // defaultQueryTimeoutMs: undefined, // Dejar que Baileys use su default
            // keepAliveIntervalMs: 20000, // Para mantener la conexión activa
        });
    } catch (e) {
        console.error("Error CRÍTICO al llamar a makeWASocket:", e);
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error fatal creando instancia de WhatsApp: ' + e.message } }));
        }
        return; // No continuar si makeWASocket falla
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
            let reason = `Conexión cerrada (Código: ${statusCode || 'N/A'}). `;

            if (statusCode === DisconnectReason.loggedOut) {
                reason += 'Sesión cerrada desde el teléfono o por WhatsApp. Deberás escanear el QR de nuevo.';
                await cleanupSessionFiles(); // Limpiar todo
                if (waSocketInstance) waSocketInstance = null;
            } else if (statusCode === DisconnectReason.connectionLost) {
                reason += 'Conexión perdida con el servidor de WhatsApp.';
                // Baileys intentará reconectar en algunos casos. Si falla persistentemente, se necesitará nuevo QR.
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                reason += 'Conexión reemplazada (otra sesión abierta).';
                // No limpiar credenciales, podría ser el mismo usuario en otro navegador/PC del bot.
                // Pero la instancia actual es inútil.
                if (waSocketInstance) waSocketInstance = null;
            } else if (statusCode === DisconnectReason.timedOut) {
                reason += 'Tiempo de conexión agotado.';
            } else if (statusCode === DisconnectReason.multideviceMismatch) {
                reason += 'Error de Multi-dispositivo (sesión inválida). Por favor, escanea el QR de nuevo.';
                await cleanupSessionFiles(); // Limpiar todo
                if (waSocketInstance) waSocketInstance = null;
            } else if (statusCode === DisconnectReason.restartRequired) {
                reason += 'El servidor de WhatsApp solicitó un reinicio de la conexión.';
                // La instancia actual es inútil. El usuario debe generar nuevo QR.
                if (waSocketInstance) waSocketInstance = null;
            } else {
                reason += `Razón: ${lastDisconnect?.error?.message || 'Desconocida'}.`;
            }
            console.log(reason);
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: reason } }));
            }
            // Si la instancia se vuelve inútil por cualquier razón no gestionada arriba, asegurar que se limpia.
            if (waSocketInstance && (statusCode !== DisconnectReason.connectionLost && statusCode !== DisconnectReason.connectionReplaced)) {
                 // Si no es una pérdida temporal o reemplazo, la instancia actual es probablemente inválida.
                 // killExistingSocket(); // Podría ser muy agresivo aquí y causar bucles.
                 // Mejor confiar en que el usuario genere un nuevo QR.
            }
        }

        if (connection === 'open') {
            console.log('¡WhatsApp conectado exitosamente!');
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp Conectado' } }));
            }
        }
    });

    waSocketInstance.ev.on('creds.update', saveCreds);
}


// ... (El resto de server.js: sendMessageWithRetry, messageSendingLoop, wss.on('connection', ...), etc. DEBERÍA SER IGUAL)
// ... (Pega aquí el resto del código desde la función sendMessageWithRetry hasta el final, de la respuesta anterior)
// ... (ASEGÚRATE DE COPIAR EL RESTO DEL ARCHIVO CORRECTAMENTE)
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
    if (globalWsClient && globalWsClient.readyState === WebSocket.OPEN) {
        console.warn("Un cliente WebSocket ya estaba conectado. El nuevo cliente lo reemplazará.");
        globalWsClient.close(1000, "Nueva conexión de cliente establecida");
    }
    globalWsClient = ws; 
    ws.send(JSON.stringify({ type: 'info', payload: { message: 'Conectado al servidor WebSocket.' } }));

    setTimeout(() => { 
        if (ws.readyState === WebSocket.OPEN) {
            if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN && waSocketInstance.user ) { 
                console.log("Sesión de Baileys activa. Notificando al frontend.");
                ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya estaba conectado.' } }));
            } else {
                 ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'WhatsApp no conectado. Solicita QR.' } }));
            }
        }
    }, 500);


    ws.on('message', async (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('Recibido del cliente:', parsedMessage.type, parsedMessage.payload ? JSON.stringify(parsedMessage.payload).substring(0,100)+'...' : '');

            switch (parsedMessage.type) {
                case 'get_initial_baileys_status': 
                    if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN && waSocketInstance.user ) {
                        ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya conectado.' } }));
                    } else {
                         ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'WhatsApp no conectado. Solicita QR.' } }));
                    }
                    break;
                case 'generate_qr_request':
                    console.log("Solicitud del cliente para generar QR/Iniciar Baileys...");
                    startBaileys(ws).catch(err => {
                        console.error("Error al procesar generate_qr_request (startBaileys):", err);
                        if (ws.readyState === WebSocket.OPEN) {
                           ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error al iniciar WhatsApp: ' + err.message } }));
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
                    console.log("Solicitud del cliente para cerrar sesión de Baileys...");
                    await killExistingSocket();
                    await cleanupSessionFiles();
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: 'Sesión cerrada por el usuario.' } }));
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
        console.log(`Cliente WebSocket desconectado (ID global era: ${globalWsClient === ws})`);
        if (ws === globalWsClient) {
            globalWsClient = null; 
        }
        // No cerrar Baileys aquí, permitir que persista si es posible.
    });

    ws.on('error', (error) => {
        console.error('Error en WebSocket del cliente:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor WABot escuchando en http://localhost:${PORT} (o la URL de Render)`);
});