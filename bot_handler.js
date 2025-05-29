// bot_handler.js
const { createBot, createProvider, createFlow, addKeyword, MemoryDB } = require('@builderbot/bot');
const { BaileysProvider } = require('@builderbot/provider-baileys');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

let botInstance;
let adapterProvider;
let qrCodeData = null;
let botState = 'pending'; // pending, qr, ready, sending, paused, stopped, finished, error, disconnected
let contactList = [];
let currentMessage = '';
let sendingInterval = 5000; // 5 segundos por defecto
let currentIndex = 0;
let sendIntervalId = null;
let progressUpdateCallback = () => {}; // Callback para actualizar el frontend vía Socket.IO

let isInitializing = false; // Semáforo para evitar múltiples inicializaciones concurrentes
let initializationTimeoutId = null; // Para el timeout

// Flujo dummy, no se usa realmente para enviar, pero builderbot necesita un flujo
const mainFlow = addKeyword(['hello-bot-custom-keyword-ignore'])
    .addAnswer('Bot está activo. Este es un flujo de respuesta automático no destinado a la interacción del usuario para esta aplicación.');

async function initializeBot(progressCb) {
    if (isInitializing && botState !== 'disconnected' && botState !== 'error' && botState !== 'pending') { // Permitir reintento si está desconectado o en error
        console.log("BOT_HANDLER: Inicialización ya en curso y no en estado fallido. Omitiendo llamada duplicada.");
        return;
    }
    isInitializing = true;
    progressUpdateCallback = progressCb;
    botState = 'initializing';
    console.log("BOT_HANDLER: Iniciando initializeBot...");
    progressUpdateCallback({ state: botState, qr: null, progress: 0, total: 0, sent: 0, error: null });

    // Limpiar timeout anterior si existe
    if (initializationTimeoutId) clearTimeout(initializationTimeoutId);

    try {
        if (adapterProvider) {
            console.log("BOT_HANDLER: Limpiando instancia de adapterProvider anterior...");
            if (typeof adapterProvider.logout === 'function') {
                try { await adapterProvider.logout(); } catch (e) { console.error("BOT_HANDLER: Error al hacer logout del provider anterior", e.message); }
            } else if (adapterProvider.ws && typeof adapterProvider.ws.end === 'function') {
                adapterProvider.ws.end(new Error('Re-initializing bot by ending old ws connection'));
            }
            adapterProvider = null;
        }
        if (botInstance) {
            // No hay método de destroy explícito, se sobrescribirá.
            botInstance = null;
        }
        console.log("BOT_HANDLER: Instancias anteriores limpiadas (si existían).");

        console.log("BOT_HANDLER: Creando proveedor Baileys...");
        const newAdapterProvider = createProvider(BaileysProvider);
        console.log("BOT_HANDLER: Proveedor Baileys creado en memoria.");

        newAdapterProvider.on('qr', (qr) => {
            if (initializationTimeoutId) clearTimeout(initializationTimeoutId);
            qrCodeData = qr;
            botState = 'qr';
            isInitializing = false;
            console.log('BOT_HANDLER: Evento QR recibido. QR Data:', qr ? 'Sí (generado)' : 'No (vacío)');
            progressUpdateCallback({ state: botState, qr: qrCodeData });
        });

        newAdapterProvider.on('ready', () => {
            if (initializationTimeoutId) clearTimeout(initializationTimeoutId);
            botState = 'ready';
            qrCodeData = null;
            isInitializing = false;
            console.log('BOT_HANDLER: Evento READY recibido. Conexión WhatsApp establecida.');
            progressUpdateCallback({ state: botState, qr: null });
        });

        newAdapterProvider.on('close', ({ reason }) => {
            if (initializationTimeoutId) clearTimeout(initializationTimeoutId);
            botState = 'disconnected';
            qrCodeData = null;
            isInitializing = false;
            console.log('BOT_HANDLER: Evento CLOSE recibido. Razón:', reason);
            progressUpdateCallback({ state: botState, qr: null, error: `Conexión cerrada: ${reason}` });
        });
        
        newAdapterProvider.on('error', (err) => {
            // No limpiar timeout aquí necesariamente, 'close' podría seguir.
            console.error('BOT_HANDLER: Error en BaileysProvider (evento "error"):', err.message || err);
            // El estado 'error' podría manejarse si 'close' no lo hace o si es un error no fatal
            // if (botState !== 'disconnected') {
            //     // isInitializing = false; // Podría ser prematuro
            //     botState = 'error';
            //     progressUpdateCallback({ state: botState, qr: null, error: `Error del proveedor: ${err.message || err}` });
            // }
        });
        
        adapterProvider = newAdapterProvider;
        const adapterDB = new MemoryDB();
        const adapterFlow = createFlow([mainFlow]);

        console.log("BOT_HANDLER: Llamando a createBot con el nuevo proveedor...");
        botInstance = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });
        console.log("BOT_HANDLER: createBot completado (estructura del bot creada). Esperando eventos de Baileys (qr, ready)...");
        
        // Configurar un timeout para la inicialización.
        initializationTimeoutId = setTimeout(() => {
            if (isInitializing && botState === 'initializing') { // Solo si sigue en este estado y no se resolvió
                console.error("BOT_HANDLER: Timeout de inicialización (60s). No se recibió 'qr' ni 'ready'.");
                botState = 'error';
                isInitializing = false;
                progressUpdateCallback({
                    state: botState,
                    qr: null,
                    error: "Timeout de inicialización. El bot no pudo conectarse. Intenta de nuevo o revisa los logs del servidor."
                });
            }
        }, 75000); // 75 segundos, Baileys a veces puede tardar.

    } catch (error) {
        if (initializationTimeoutId) clearTimeout(initializationTimeoutId);
        console.error("BOT_HANDLER: Fallo CRÍTICO en initializeBot (catch general):", error);
        botState = 'error';
        isInitializing = false;
        progressUpdateCallback({ state: botState, qr: null, error: "Fallo al crear el bot: " + (error.message || error) });
    }
}

// La IA anterior se detuvo aquí. Builderbot/Baileys maneja el QR vía eventos.
// Esta función puede devolver el QR almacenado si está disponible.
async function getQRCode() {
    // Esta función es más bien un getter para el QR que se obtiene por evento.
    // No "genera" activamente el QR bajo demanda de esta forma usualmente.
    if (botState === 'qr' && qrCodeData) {
        return qrCodeData;
    }
    // Si el bot no está en estado 'qr', no hay QR para devolver o ya se escaneó.
    // Se podría llamar a initializeBot si el bot no está inicializado,
    // pero es mejor manejarlo desde un endpoint /init-bot como en server.js.
    return null; 
}


function parseXLSX(filePath) {
    try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        // header: 1 para obtener array de arrays, más fácil para indexar por columna B, D, etc.
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        if (jsonData.length < 2) { // Mínimo una fila de encabezado y una de datos
            throw new Error("El archivo XLSX está vacío o no tiene datos.");
        }

        contactList = [];
        // Saltar la fila 0 (encabezados)
        for (let i = 1; i < jsonData.length; i++) {
            const row = jsonData[i];
            
            // Columna B para Nombre (índice 1)
            let fullName = row[1] ? String(row[1]).trim() : '';
            let firstName = fullName.split(' ')[0]; 

            if (!firstName) continue; // Saltar si no hay nombre

            let numbers = [];
            // Columnas D, E, F para números (índices 3, 4, 5)
            [row[3], row[4], row[5]].forEach(numCell => {
                let num = numCell ? String(numCell).replace(/\D/g, '').trim() : ''; // Limpiar no dígitos
                if (num.startsWith('9') && num.length === 9) {
                    numbers.push(`51${num}`); // Anteponer código de Perú
                } else if (num.startsWith('519') && num.length === 11) { // Ya tiene +51
                     numbers.push(num);
                }
            });

            if (numbers.length > 0) {
                numbers.forEach(processedNumber => {
                    contactList.push({ name: firstName, number: processedNumber });
                });
            }
        }
        
        try {
            fs.unlinkSync(filePath); // Eliminar archivo después de procesar
        } catch (unlinkErr) {
            console.error("Error deleting temp file:", unlinkErr);
        }

        botState = 'file_processed'; // Un estado intermedio antes de 'ready' para enviar
        progressUpdateCallback({ state: botState, total: contactList.length, sent: 0, progress: 0 });
        return { success: true, count: contactList.length, contactsPreview: contactList.slice(0,5) };
    } catch (error) {
        console.error("Error parsing XLSX:", error);
         try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (unlinkErr) {
            console.error("Error deleting temp file on error:", unlinkErr);
        }
        progressUpdateCallback({ state: 'error', error: "Error parsing XLSX: " + error.message });
        return { success: false, error: error.message };
    }
}

async function sendMessageToContact(contact) {
    if (!adapterProvider || (botState !== 'ready' && botState !== 'sending' && botState !== 'file_processed' && botState !== 'paused')) {
        console.log(`Bot not ready (state: ${botState}) or provider not available to send to ${contact.number}.`);
        throw new Error(`Bot no conectado o en estado incorrecto (${botState}). Escanea el QR o espera.`);
    }
    
    const personalizedMessage = currentMessage.replace(/{nombre}/gi, contact.name);
    const targetJid = `${contact.number}@s.whatsapp.net`;

    try {
        console.log(`Intentando enviar a ${targetJid}: ${personalizedMessage}`);
        // Usar adapterProvider.sendText es común para Baileys.
        // botInstance.sendMessage también podría estar disponible dependiendo de la abstracción de builderbot.
        await adapterProvider.sendText(targetJid, personalizedMessage);
        console.log(`Mensaje enviado a ${contact.name} (${targetJid})`);
        return { success: true, contact };
    } catch (error) {
        console.error(`Fallo al enviar mensaje a ${contact.name} (${targetJid}):`, error);
        return { success: false, contact, error: error.message };
    }
}

async function startSendingProcess(message, interval) {
    if (botState !== 'ready' && botState !== 'file_processed' && botState !== 'paused' && botState !== 'stopped' && botState !== 'finished') {
        throw new Error(`El bot no está listo para enviar (estado actual: ${botState}). Conecta WhatsApp y carga un archivo.`);
    }
    if (contactList.length === 0) {
        throw new Error("No hay contactos para enviar mensajes. Carga un archivo XLSX.");
    }
    if (currentIndex > 0 && botState !== 'paused') { // Si se detuvo y se reinicia, o si ya terminó
         currentIndex = 0; // Resetear para una nueva campaña si no es una reanudación
    }

    currentMessage = message;
    sendingInterval = parseInt(interval, 10) || 5000;
    botState = 'sending';
    
    progressUpdateCallback({ state: botState, total: contactList.length, sent: currentIndex, progress: (currentIndex / contactList.length) * 100 });

    sendIntervalId = setInterval(async () => {
        if (currentIndex >= contactList.length) {
            stopSendingProcess(true); // Campaña finalizada
            return;
        }
        if (botState !== 'sending') { 
            clearInterval(sendIntervalId);
            sendIntervalId = null;
            console.log(`Envío detenido o pausado internamente. Estado actual: ${botState}`);
            return;
        }

        const contact = contactList[currentIndex];
        let success = false;
        try {
            const result = await sendMessageToContact(contact);
            success = result.success;
        } catch (error) {
            console.error(`Error enviando a ${contact.name}: ${error.message}`);
            // El error ya se reportó en sendMessageToContact
        }
        
        // Avanzar incluso si hay error para no atascarse, o implementar reintentos
        currentIndex++;
        progressUpdateCallback({
            state: botState,
            total: contactList.length,
            sent: currentIndex, // Refleja el intento número 'currentIndex' completado (sea exitoso o no)
            progress: (currentIndex / contactList.length) * 100,
            lastSent: { name: contact.name, success: success, error: success ? null : `Fallo al enviar a ${contact.name}` }
        });
        

        if (currentIndex >= contactList.length) {
            stopSendingProcess(true); // Campaña finalizada
        }
    }, sendingInterval);
}

function pauseSendingProcess() {
    if (botState !== 'sending') return;
    botState = 'paused';
    clearInterval(sendIntervalId);
    sendIntervalId = null;
    console.log("Envío pausado.");
    progressUpdateCallback({ state: botState, total: contactList.length, sent: currentIndex, progress: (currentIndex / contactList.length) * 100 });
}

function resumeSendingProcess() {
    if (botState !== 'paused') return;
    if (currentIndex >= contactList.length) {
        console.log("La campaña ya ha finalizado.");
        stopSendingProcess(true);
        return;
    }
    // startSendingProcess continuará desde currentIndex
    startSendingProcess(currentMessage, sendingInterval);
}

function stopSendingProcess(finished = false) {
    botState = finished ? 'finished' : 'stopped';
    clearInterval(sendIntervalId);
    sendIntervalId = null;
    
    const finalProgress = contactList.length > 0 ? (currentIndex / contactList.length) * 100 : (finished ? 100 : 0);
    const finalSent = currentIndex;

    if (!finished) {
        console.log("Envío detenido por el usuario.");
    } else {
        console.log("Todos los mensajes enviados. Campaña finalizada.");
    }
    
    progressUpdateCallback({ state: botState, total: contactList.length, sent: finalSent, progress: finalProgress });
    // No resetear currentIndex aquí si queremos que el estado 'stopped' o 'finished' muestre el progreso final.
    // Se reseteará en startSendingProcess si se inicia una nueva campaña.
}

async function logout() {
    console.log("BOT_HANDLER: Iniciando logout...");
    isInitializing = false; // Detener cualquier inicialización en curso
    if (initializationTimeoutId) clearTimeout(initializationTimeoutId);

    if (sendIntervalId) {
        clearInterval(sendIntervalId);
        sendIntervalId = null;
    }

    if (adapterProvider) {
        try {
            if (typeof adapterProvider.logout === 'function') {
                console.log("BOT_HANDLER: Llamando a adapterProvider.logout()...");
                await adapterProvider.logout();
                console.log('BOT_HANDLER: Logout de Baileys (vía provider.logout) exitoso.');
            } else if (adapterProvider.ws && typeof adapterProvider.ws.end === 'function') {
                console.log("BOT_HANDLER: adapterProvider.logout no encontrado, usando ws.end()...");
                adapterProvider.ws.end(new Error('Logout solicitado por el usuario'));
                console.log('BOT_HANDLER: Logout forzado cerrando WebSocket.');
            } else {
                 console.log('BOT_HANDLER: Función de logout no disponible en el proveedor actual.');
            }
        } catch (error) {
            console.error('BOT_HANDLER: Error durante el logout de Baileys:', error);
        }
        adapterProvider = null;
    }
    
    botInstance = null;
    qrCodeData = null;
    contactList = [];
    currentIndex = 0;
    botState = 'pending';

    progressUpdateCallback({ state: botState, qr: null, progress: 0, total: 0, sent: 0, error: "Sesión cerrada." });
    console.log("BOT_HANDLER: Estado del bot reseteado después del logout.");
}

function getBotStatus() {
    return {
        state: botState,
        qr: qrCodeData,
        totalContacts: contactList.length,
        sentMessages: currentIndex,
        progress: contactList.length > 0 ? (currentIndex / contactList.length) * 100 : 0,
        isInitializing: isInitializing // Informar si está en proceso
    };
}

module.exports = {
    initializeBot,
    getQRCode,
    parseXLSX,
    startSendingProcess,
    pauseSendingProcess,
    resumeSendingProcess,
    stopSendingProcess,
    logout,
    getBotStatus,
};