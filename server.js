const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const AUTH_FILE_PATH = './baileys_auth_info'; // Carpeta para guardar la sesión

// Servir el archivo HTML principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let waSocketInstance = null;
let globalWsClient = null; // Para enviar actualizaciones de Baileys al frontend correcto

// Variables para el proceso de envío
let globalContacts = [];
let globalMessageTemplate = "";
let globalIntervalSeconds = 5;
let globalBatchSize = 20;
let currentSendingIndex = 0;
let sendingLoopTimeout = null;
let isSendingProcessActive = false;
let isSendingProcessPaused = false;

// Para el store en memoria (opcional, pero útil para algunas funcionalidades de Baileys)
const store = makeInMemoryStore({});
store.readFromFile('./baileys_store.json'); // Cargar datos si existen
setInterval(() => {
    store.writeToFile('./baileys_store.json'); // Guardar periódicamente
}, 10_000);


async function startBaileys(wsClient) {
    if (waSocketInstance) {
        try {
            // No se puede simplemente "end" y reiniciar inmediatamente con la misma auth si ya está conectado o conectando.
            // Es mejor manejar el logout explícitamente.
            // Si se llama a startBaileys y ya hay una instancia, podría ser para un nuevo QR.
            console.log('Cerrando instancia de Baileys existente antes de crear una nueva...');
            await waSocketInstance.logout(); // O waSocketInstance.end(...) si prefieres solo cerrar sin borrar sesión del teléfono
        } catch (e) {
            console.error("Error al cerrar instancia previa de Baileys:", e.message);
        }
        waSocketInstance = null;
        // Limpiar credenciales para forzar nuevo QR si se vuelve a generar
        if (fs.existsSync(AUTH_FILE_PATH)) {
            fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
            console.log('Credenciales de autenticación anteriores eliminadas.');
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FILE_PATH);

    waSocketInstance = makeWASocket({
        auth: state,
        printQRInTerminal: false, // No queremos el QR en la terminal del servidor
        browser: Browsers.macOS('Desktop'), // Simula ser un navegador de escritorio
        logger: require('pino')({ level: 'silent' }) // 'info' o 'debug' para más logs de Baileys
    });

    store.bind(waSocketInstance.ev);

    waSocketInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && wsClient && wsClient.readyState === WebSocket.OPEN) {
            console.log('QR recibido, enviando al frontend.');
            wsClient.send(JSON.stringify({ type: 'qr_code', payload: { qr } }));
        }

        if (connection === 'close') {
            const boomError = new Boom(lastDisconnect?.error);
            const statusCode = boomError?.output?.statusCode;
            let reason = 'Conexión cerrada. ';

            if (statusCode === DisconnectReason.loggedOut) {
                reason += 'Sesión cerrada (logged out). Deberás escanear el QR de nuevo.';
                if (fs.existsSync(AUTH_FILE_PATH)) {
                    fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                }
                waSocketInstance = null; // Limpiar la instancia
            } else if (statusCode === DisconnectReason.connectionLost) {
                reason += 'Conexión perdida con el servidor. Intentando reconectar...';
                // Baileys intentará reconectar automáticamente en muchos casos.
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                reason += 'Conexión reemplazada. Otra sesión se abrió en otro lugar.';
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
                reason += `Razón desconocida o no manejada: ${statusCode || 'N/A'}.`;
                if (waSocketInstance) { // Intentar reconectar si no es un logout explícito
                   // startBaileys(wsClient); // Esto podría causar bucles, manejar con cuidado
                }
            }
            console.log(reason);
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({ type: 'connection_update', payload: { status: 'close', message: reason } }));
            }
             // Si la conexión se cierra y no es un logout, podrías intentar reiniciar Baileys aquí.
            // Pero cuidado con los bucles. Quizás sea mejor que el usuario lo haga manualmente.
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
        // Verificar si el número está en WhatsApp (opcional pero recomendado)
        // const [result] = await waSocketInstance.onWhatsApp(jid);
        // if (!result || !result.exists) {
        //     throw new Error('El número no está registrado en WhatsApp.');
        // }
        
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
    globalWsClient = ws; // Asignar el cliente WebSocket actual
    ws.send(JSON.stringify({ type: 'info', payload: { message: 'Conectado al servidor WebSocket.' } }));

    // Verificar si ya hay una sesión de Baileys activa al conectar un nuevo cliente WebSocket
    // Esto es útil si el servidor se reinició pero la sesión de Baileys persistió.
    // O si el frontend se recargó.
    if (waSocketInstance && waSocketInstance.ws?.socket?.readyState === WebSocket.OPEN) { // Chequeo más robusto del estado de Baileys
         console.log("Una sesión de Baileys ya está activa. Notificando al frontend.");
         ws.send(JSON.stringify({ type: 'connection_update', payload: { status: 'open', message: 'WhatsApp ya estaba conectado.' } }));
    } else if (fs.existsSync(AUTH_FILE_PATH)) {
        // Si existe la carpeta de autenticación pero no hay instancia activa, intentar reconectar.
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
                    if (!waSocketInstance) {
                        ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error: WhatsApp no está conectado. Conecta primero.' } }));
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
                        messageSendingLoop(ws); // Reanudar el bucle
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
                
                case 'reset_baileys_request': // Para cerrar sesión
                    console.log("Solicitud para cerrar sesión de Baileys...");
                    if (waSocketInstance) {
                        try {
                            await waSocketInstance.logout(); // Esto debería disparar 'connection.update' con loggedOut
                            console.log("Logout de Baileys exitoso.");
                        } catch (e) {
                            console.error("Error durante el logout de Baileys:", e);
                             if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'error_message', payload: { message: 'Error al cerrar sesión: ' + e.message } }));
                             }
                        } finally {
                            waSocketInstance = null;
                            if (fs.existsSync(AUTH_FILE_PATH)) {
                                fs.rmSync(AUTH_FILE_PATH, { recursive: true, force: true });
                                console.log('Credenciales de autenticación eliminadas tras logout.');
                            }
                             // Enviar una actualización de conexión explícita si el evento de Baileys no lo hace rápido
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
                    // Detener cualquier envío en curso
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
            globalWsClient = null; // Limpiar si este era el cliente global
        }
        // No necesariamente cerrar Baileys aquí, ya que otro cliente podría conectarse
        // O Baileys podría seguir corriendo en segundo plano si es la intención.
        // Si se quiere que Baileys se cierre cuando el único cliente se desconecta:
        // if (wss.clients.size === 0 && waSocketInstance) {
        //     console.log("Último cliente desconectado, cerrando Baileys...");
        //     waSocketInstance.end(new Boom('Client disconnected', { statusCode: DisconnectReason.connectionClosed }));
        //     waSocketInstance = null;
        // }
    });

    ws.on('error', (error) => {
        console.error('Error en WebSocket del cliente:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Servidor WABot escuchando en http://localhost:${PORT}`);
});