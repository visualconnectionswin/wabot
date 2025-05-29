// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // Para asegurar que 'uploads' existe
const botHandler = require('./bot_handler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3008;

// Asegurar que el directorio 'uploads' existe
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')); // Sanitize filename
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Límite de 10MB para archivos
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('Cliente conectado vía Socket.IO');
    socket.emit('statusUpdate', botHandler.getBotStatus()); // Enviar estado actual al nuevo cliente
    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

function broadcastStatusUpdate(status) {
    io.emit('statusUpdate', status);
}

// Inicializar el bot con el callback para Socket.IO
// Esto se llama una vez cuando el servidor arranca.
botHandler.initializeBot(broadcastStatusUpdate);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/init-bot', async (req, res) => {
    const status = botHandler.getBotStatus();
    if (status.state === 'qr' && status.qr) {
        res.json({ success: true, qrCode: status.qr, message: "Escanea el código QR." });
    } else if (status.state === 'ready') {
        res.json({ success: true, message: "Bot está listo." });
    } else if (status.state === 'pending' || status.state === 'initializing' || status.state === 'disconnected' || status.state === 'error') {
        console.log(`Estado del bot: ${status.state}. Re-intentando inicialización si es necesario.`);
        // Si no está inicializado o en error, intentar (re)inicializar.
        // initializeBot ya se llama al inicio. Este endpoint es más para obtener el QR si ya está disponible
        // o para forzar un reintento si está en un mal estado.
        if (status.state === 'disconnected' || status.state === 'error' || status.state === 'pending') {
             await botHandler.initializeBot(broadcastStatusUpdate); // Forzar re-inicialización
        }
        // La respuesta vendrá por Socket.IO, pero damos un mensaje inmediato.
        res.json({ success: true, message: "Proceso de inicialización/re-inicialización en curso. Espera el QR o estado 'listo' en la UI." });
    } else {
        res.json({ success: false, message: `Estado actual del bot: ${status.state}. No se requiere acción.` });
    }
});

app.post('/api/upload-xlsx', upload.single('contactsFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No se subió ningún archivo." });
    }
    const result = botHandler.parseXLSX(req.file.path);
    if (result.success) {
        res.json({ 
            success: true, 
            message: `${result.count} contactos cargados.`, 
            totalContacts: result.count,
            preview: result.contactsPreview 
        });
    } else {
        res.status(500).json({ success: false, message: result.error });
    }
});

app.post('/api/start-sending', async (req, res) => {
    const { message, interval } = req.body;
    if (!message || !interval) {
        return res.status(400).json({ success: false, message: "Mensaje e intervalo son requeridos." });
    }
    try {
        await botHandler.startSendingProcess(message, interval);
        res.json({ success: true, message: "Proceso de envío de mensajes iniciado." });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/pause-sending', (req, res) => {
    try {
        botHandler.pauseSendingProcess();
        res.json({ success: true, message: "Envío de mensajes pausado." });
    } catch (error) { // Aunque pauseSendingProcess no es async y no debería lanzar errores así.
        res.status(500).json({ success: false, message: "Error al pausar: " + error.message });
    }
});

app.post('/api/resume-sending', (req, res) => {
    try {
        botHandler.resumeSendingProcess();
        res.json({ success: true, message: "Envío de mensajes reanudado." });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/stop-sending', (req, res) => {
    try {
        botHandler.stopSendingProcess(false); // false indica que no finalizó naturalmente
        res.json({ success: true, message: "Envío de mensajes detenido." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al detener: " + error.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await botHandler.logout();
        res.json({ success: true, message: "Sesión cerrada exitosamente." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al cerrar sesión: " + error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json(botHandler.getBotStatus());
});

function startServer() {
    server.listen(PORT, () => {
        console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
        console.log(`Render usará el puerto ${PORT} si está definido en las variables de entorno.`);
    });
}

module.exports = { startServer };