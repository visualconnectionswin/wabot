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

// Flujo dummy, no se usa realmente para enviar, pero builderbot necesita un flujo
const mainFlow = addKeyword(['hello-bot-custom-keyword-ignore'])
    .addAnswer('Bot está activo. Este es un flujo de respuesta automático no destinado a la interacción del usuario para esta aplicación.');

async function initializeBot(progressCb) {
    progressUpdateCallback = progressCb;
    botState = 'initializing';
    console.log("Initializing bot...");
    progressUpdateCallback({ state: botState, qr: null, progress: 0, total: 0, sent: 0, error: null });

    try {
        const adapterDB = new MemoryDB();
        const adapterFlow = createFlow([mainFlow]);
        adapterProvider = createProvider(BaileysProvider);

        adapterProvider.on('qr', (qr) => {
            qrCodeData = qr;
            botState = 'qr';
            console.log('QR Code Generated. Scan with WhatsApp.');
            progressUpdateCallback({ state: botState, qr: qrCodeData });
        });

        adapterProvider.on('ready', () => {
            botState = 'ready';
            qrCodeData = null; 
            console.log('WhatsApp connected successfully!');
            progressUpdateCallback({ state: botState, qr: null });
        });

        adapterProvider.on('close', ({ reason }) => {
            botState = 'disconnected';
            qrCodeData = null;
            console.log('WhatsApp connection closed. Reason:', reason);
            progressUpdateCallback({ state: botState, qr: null, error: `Connection closed: ${reason}` });
        });
        
        adapterProvider.on('error', (err) => {
            console.error('BaileysProvider error:', err);
            // No cambiar botState aquí directamente si 'close' ya lo maneja, para evitar doble update.
            // Si es un error que no cierra la conexión, entonces sí actualizar.
            if (botState !== 'disconnected') {
                 botState = 'error';
                 progressUpdateCallback({ state: botState, qr: null, error: `Provider error: ${err.message || err}` });
            }
        });

        botInstance = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });
        console.log("Bot created successfully.");
        // Si createBot devuelve un httpServer y necesitas configurarlo, hazlo aquí.
        // Por ejemplo, si necesitas pasarle el puerto de Render o integrarlo con Express.
        // Pero para esta app, el server.js maneja el servidor principal.
        // No llamamos a adapterProvider.initHttpServer() aquí, asumimos que createBot lo maneja
        // o que no es necesario para la generación de QR vía evento y envío de mensajes.

    } catch (error) {
        console.error("Failed to create or initialize bot:", error);
        botState = 'error';
        progressUpdateCallback({ state: botState, qr: null, error: "Failed to create bot: " + (error.message || error) });
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
    console.log("Intentando cerrar sesión...");
    if (adapterProvider && typeof adapterProvider.logout === 'function') {
        try {
            await adapterProvider.logout();
            console.log('Cierre de sesión de Baileys exitoso.');
        } catch (error) {
            console.error('Error durante el logout de Baileys:', error);
            // Continuar para resetear estado local de todas formas
        }
    } else if (botInstance && botInstance.ws && typeof botInstance.ws.end === 'function') {
        botInstance.ws.end(new Error('Logout solicitado por el usuario')); // Para versiones más antiguas de Baileys
        console.log('Logout forzado cerrando WebSocket.');
    } else {
        console.log('Función de logout no disponible en el proveedor o botInstance no conectado.');
    }

    botState = 'pending'; // Estado inicial después de logout
    qrCodeData = null;
    contactList = [];
    currentIndex = 0;
    if (sendIntervalId) clearInterval(sendIntervalId);
    sendIntervalId = null;
    // Considerar si botInstance y adapterProvider deben ser nullificados y recreados en initializeBot
    // Esto es importante para asegurar una sesión limpia.
    // Por ahora, initializeBot los recrea.

    progressUpdateCallback({ state: botState, qr: null, progress: 0, total: 0, sent: 0, error: "Sesión cerrada." });
    console.log("Estado del bot reseteado después del logout.");
    // Podrías querer forzar una reinicialización del bot aquí o dejar que el usuario lo haga.
    // await initializeBot(progressUpdateCallback); // Opcional: re-inicializar automáticamente.
}

function getBotStatus() {
    return {
        state: botState,
        qr: qrCodeData, // Podría ser null si ya está conectado o no se ha generado
        totalContacts: contactList.length,
        sentMessages: currentIndex,
        progress: contactList.length > 0 ? (currentIndex / contactList.length) * 100 : 0
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