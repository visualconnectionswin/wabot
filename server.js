import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
// import QRCode from 'qrcode'; // QRCode no se usa directamente, Baileys genera el QR.
import cron from 'node-cron';
import winston from 'winston';
import Joi from 'joi';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import moment from 'moment-timezone';
import dotenv from 'dotenv';

// BuilderBot imports
import { createBot, createProvider, createFlow } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { JsonFileDB } from '@builderbot/database-json';

// Environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Lima';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SESSIONS_DIR = './baileys_auth_info'; // Directorio para la sesión de Baileys
const DB_PATH = './db.json'; // Path para el archivo de la base de datos JSON
const UPLOADS_DIR = './uploads';
const LOGS_DIR = './logs';

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'bulk_send',
  points: 100, // Number of requests
  duration: 3600, // Per hour
});

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-bulk-sender' },
  transports: [
    new winston.transports.File({ filename: `${LOGS_DIR}/error.log`, level: 'error' }),
    new winston.transports.File({ filename: `${LOGS_DIR}/combined.log` }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Ensure directories exist
await Promise.all([
  fs.mkdir(SESSIONS_DIR, { recursive: true }),
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
  fs.mkdir(LOGS_DIR, { recursive: true }),
  fs.mkdir('./public', { recursive: true }) // Para el index.html
]);

// Express app setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"]
    }
  }
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', `http://localhost:${PORT}`],
  credentials: true
}));

app.use(compression());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// File upload configuration
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
    }
  }
});

// Validation schemas
const messageSchema = Joi.object({
  contacts: Joi.array().items(Joi.object({
    name: Joi.string().required(),
    numbers: Joi.array().items(Joi.string().pattern(/^\+51[9]\d{8}$/)).min(1).required(),
    rowIndex: Joi.number().required()
  })).min(1).required(),
  messageTemplate: Joi.string().min(1).max(4000).required(),
  delay: Joi.number().min(1000).max(300000).default(3000),
  mediaUrl: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').optional(),
  mediaType: Joi.string().valid('image', 'video', 'document', 'audio').allow('').optional(),
  scheduledTime: Joi.date().greater('now').optional()
});

// BuilderBot setup
const flowWelcome = createFlow([]); // Un flujo vacío es suficiente para esta aplicación

const main = async () => {
  const database = new JsonFileDB({ filename: DB_PATH });
  logger.info(`Database adapter initialized with file: ${DB_PATH}`);

  const provider = createProvider(BaileysProvider, {
    name: 'whatsapp-bulk-sender',
    gifPlayback: false,
    timeRelease: 10800000, // 3 hours
    usePairingCode: true,
    phoneNumber: process.env.PHONE_NUMBER || null
  });

  provider.on('require_action', ({ qr, code }) => {
    if (qr) { // Este evento puede no dispararse si usePairingCode=true y no hay sesión
        logger.info('QR Code received for authentication. Check bot.qr.png or /api/qr endpoint.');
        // El archivo bot.qr.png lo genera Baileys internamente.
        // La UI pedirá el QR a través de /api/qr o WebSocket.
    }
    if (code) { // Este es más relevante con usePairingCode=true
        logger.info(`Pairing Code: ${code}. Please enter this code on your WhatsApp linked devices screen.`);
        global.providerInstance.pairingCode = code; // Guardar para enviarlo por WebSocket si se solicita
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'pairing_code', data: code }));
            }
        });
    }
  });

  provider.on('ready', () => {
    logger.info('WhatsApp Provider is ready!');
    if (global.providerInstance) global.providerInstance.pairingCode = null; // Limpiar pairing code si ya está listo
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: 'status_update',
                data: {
                    connected: true,
                    user: global.providerInstance?.vendor?.user || null // Acceder al usuario del vendor
                }
            }));
        }
    });
  });

  provider.on('auth_failure', (error) => {
    logger.error('WhatsApp Authentication Failure:', error);
    if (global.providerInstance) global.providerInstance.pairingCode = null;
     wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: 'status_update',
                data: {
                    connected: false,
                    user: null,
                    error: `Authentication Failed: ${error}`
                }
            }));
        }
    });
  });

  const { bot, provider: botProvider } = await createBot({
    flow: flowWelcome, // Pasar el objeto de flujo directamente
    database,
    provider
  });

  global.botInstance = bot;
  global.providerInstance = botProvider; // Esta es la instancia del proveedor ya configurada

  return { bot, provider: botProvider };
};

class BulkSendingManager {
  constructor() {
    this.processes = new Map();
    this.setupCleanupJob();
  }

  createProcess(id, data) {
    const process = {
      id,
      status: 'pending',
      currentIndex: 0,
      totalCount: data.contacts.length,
      contacts: data.contacts, // Guardar los contactos para este proceso
      messageTemplate: data.messageTemplate,
      delay: data.delay,
      mediaUrl: data.mediaUrl,
      mediaType: data.mediaType,
      scheduledTime: data.scheduledTime,
      startedAt: null,
      completedAt: null,
      successCount: 0,
      failureCount: 0,
      errors: [],
      timeout: null,
      lastActivity: Date.now()
    };
    this.processes.set(id, process);
    logger.info(`Created bulk sending process: ${id}`, { totalContacts: data.contacts.length, scheduled: !!data.scheduledTime });
    this.broadcastUpdate(process);
    return process;
  }

  getProcess(id) {
    return this.processes.get(id);
  }

  updateProcess(id, updates) {
    const process = this.processes.get(id);
    if (process) {
      Object.assign(process, updates, { lastActivity: Date.now() });
      this.broadcastUpdate(process);
    }
    return process;
  }

  deleteProcess(id) {
    const process = this.processes.get(id);
    if (process?.timeout) {
      clearTimeout(process.timeout);
    }
    this.processes.delete(id);
    logger.info(`Deleted bulk sending process: ${id}`);
  }

  async startProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status === 'running' || process.status === 'scheduled') {
        logger.warn(`Process ${id} can't start: current status ${process?.status}.`);
        return false;
    }

    if (process.scheduledTime && new Date(process.scheduledTime) > new Date()) {
      this.scheduleProcess(id);
      return true;
    }

    this.updateProcess(id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      scheduledTime: null // Ya no está pendiente de programación
    });

    this.executeProcess(id).catch(err => {
        logger.error(`Unhandled error in executeProcess for ${id}:`, err);
        this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical error: ${err.message}`] });
    });
    return true;
  }

  async pauseProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running') return false;
    if (process.timeout) {
      clearTimeout(process.timeout);
      process.timeout = null;
    }
    this.updateProcess(id, { status: 'paused' });
    logger.info(`Paused bulk sending process: ${id}`);
    return true;
  }

  async resumeProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'paused') return false;
    this.updateProcess(id, { status: 'running' });
    logger.info(`Resuming bulk sending process: ${id}`);
    this.executeProcess(id).catch(err => {
        logger.error(`Unhandled error in executeProcess (resume) for ${id}:`, err);
        this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical error: ${err.message}`] });
    });
    return true;
  }

  async stopProcess(id) {
    const process = this.getProcess(id);
    if (!process) return false;
    if (process.timeout) {
      clearTimeout(process.timeout);
      process.timeout = null;
    }
    const finalStatus = (process.status === 'scheduled' || process.currentIndex === 0) ? 'stopped' : 'stopped'; // Considerar 'failed' si nunca envió nada
    this.updateProcess(id, {
      status: finalStatus,
      completedAt: new Date().toISOString()
    });
    logger.info(`Stopped bulk sending process: ${id}`);
    return true;
  }

  scheduleProcess(id) {
    const process = this.getProcess(id);
    if (!process || !process.scheduledTime) return;
    const delayMs = new Date(process.scheduledTime).getTime() - new Date().getTime();

    if (delayMs > 0) {
      if (process.timeout) clearTimeout(process.timeout);
      process.timeout = setTimeout(async () => {
        logger.info(`Scheduled time reached for process ${id}. Attempting to start...`);
        this.updateProcess(id, { status: 'pending' }); // No limpiar scheduledTime aquí, startProcess lo hará
        await this.startProcess(id);
      }, delayMs);
      this.updateProcess(id, { status: 'scheduled' });
      logger.info(`Scheduled process ${id} for ${new Date(process.scheduledTime).toLocaleString()}. Will start in ${Math.round(delayMs / 1000)}s.`);
    } else {
      logger.info(`Scheduled time for process ${id} is in the past. Starting immediately.`);
      this.startProcess(id); // startProcess se encargará de limpiar scheduledTime
    }
  }

  async executeProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running' || !global.providerInstance || !global.providerInstance.vendor) {
        logger.warn(`Process ${id} cannot execute. Status: ${process?.status}, Provider ready: ${!!global.providerInstance?.vendor}`);
        if(process && process.status === 'running') this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), 'Provider not ready or process status invalid at execution start'] });
        return;
    }

    const { contacts, messageTemplate, delay, mediaUrl, mediaType } = process;
    logger.info(`Executing process ${id}: ${process.currentIndex}/${process.totalCount}`);

    while (process.currentIndex < process.totalCount && process.status === 'running') {
      const contact = contacts[process.currentIndex];
      const personalizedMessage = messageTemplate.replace(/{nombre}/g, contact.name || 'Cliente');

      let successfulSendsThisContact = 0;
      let errorsThisContact = [];

      for (const number of contact.numbers) {
        if (process.status !== 'running') {
            logger.info(`Process ${id} status changed to ${process.status} during number iteration. Stopping.`);
            return; // Salir si el estado del proceso cambió
        }
        try {
          await rateLimiter.consume(number).catch(rlError => {
            logger.warn(`Rate limit exceeded for ${number} in process ${id}: ${rlError.message}`);
            errorsThisContact.push(`Rate limit exceeded for ${number}`);
            throw rlError;
          });

          const formattedNumber = number.replace(/\+/g, '') + '@s.whatsapp.net';
          const [waCheckResult] = await global.providerInstance.vendor.onWhatsApp(number.replace(/\+/g, ''));

          if (!waCheckResult?.exists) {
            logger.warn(`Number ${number} (contact: ${contact.name}, row: ${contact.rowIndex}) not on WhatsApp. Process: ${id}`);
            errorsThisContact.push(`Number ${number} not on WhatsApp`);
            continue;
          }

          await global.providerInstance.vendor.sendPresenceUpdate('composing', formattedNumber);
          await this.delay(500 + Math.random() * 500);

          let messagePayload = {};
          const caption = personalizedMessage;

          if (mediaUrl && mediaType) {
            switch (mediaType) {
              case 'image': messagePayload = { image: { url: mediaUrl }, caption }; break;
              case 'video': messagePayload = { video: { url: mediaUrl }, caption }; break;
              case 'document': messagePayload = { document: { url: mediaUrl }, mimetype: this.getMimeType(mediaUrl), fileName: this.getFileName(mediaUrl), caption }; break;
              case 'audio': messagePayload = { audio: { url: mediaUrl }, mimetype: 'audio/mpeg', ptt: false }; break;
              default: messagePayload = { text: personalizedMessage };
            }
            if(mediaType !== 'audio' && !messagePayload.text && Object.keys(messagePayload).some(k => ['image', 'video', 'document'].includes(k))) {
                // Si hay media y no hay caption (porque personalizedMessage era solo para caption), y no es audio
                // Esto ya está cubierto por `caption` arriba.
            } else if (Object.keys(messagePayload).length === 0) { // Si por alguna razón mediaType es inválido y no hay payload
                 messagePayload = { text: personalizedMessage };
            }
          } else {
            messagePayload = { text: personalizedMessage };
          }

          const sendResult = await global.providerInstance.vendor.sendMessage(formattedNumber, messagePayload);
          logger.info(`Message sent to ${number} (contact: ${contact.name}, row: ${contact.rowIndex}). ID: ${sendResult.key?.id}. Process: ${id}`);
          successfulSendsThisContact++;
          await global.providerInstance.vendor.sendPresenceUpdate('available', formattedNumber);

        } catch (error) {
          logger.error(`Failed to send to ${number} (contact: ${contact.name}, row: ${contact.rowIndex}). Process: ${id}:`, error.message.substring(0, 200)); // Loguear solo parte del mensaje de error
          errorsThisContact.push(`Failed for ${number}: ${error.message.substring(0, 100)}`);
        }
        if (contact.numbers.length > 1 && process.status === 'running') {
             await this.delay(Math.max(500, Math.floor(delay / (contact.numbers.length * 2))) + Math.random() * 200);
        }
      }

      if (process.status !== 'running') {
          logger.info(`Process ${id} status changed to ${process.status} after contact processing. Stopping.`);
          return; // Salir si el estado cambió
      }

      if (successfulSendsThisContact > 0) {
        process.successCount++;
      } else {
        process.failureCount++;
        if(errorsThisContact.length > 0) { // Solo agregar si hubo errores específicos para este contacto
            process.errors.push(...errorsThisContact.map(e => `Row ${contact.rowIndex} (${contact.name}): ${e}`));
        } else if (successfulSendsThisContact === 0 && contact.numbers.length > 0) { // Si no hubo envíos exitosos pero había números
            process.errors.push(`Row ${contact.rowIndex} (${contact.name}): No messages sent successfully.`);
        }
      }

      process.currentIndex++;
      this.updateProcess(id, {
        currentIndex: process.currentIndex,
        successCount: process.successCount,
        failureCount: process.failureCount,
        errors: process.errors // Actualizar con los errores acumulados
      });

      logger.info(`Process ${id} progress: ${process.currentIndex}/${process.totalCount}. Success: ${process.successCount}, Fail: ${process.failureCount}`);

      if (process.currentIndex < process.totalCount && process.status === 'running') {
        const currentDelay = delay + (Math.random() * (delay * 0.2) - (delay * 0.1));
        process.timeout = setTimeout(() => {
            if (process.status === 'running') { // Volver a verificar antes de continuar
                 this.executeProcess(id).catch(err => { // Llamada recursiva para el siguiente contacto
                    logger.error(`Unhandled error in executeProcess (recursion) for ${id}:`, err);
                    this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical error: ${err.message}`] });
                });
            } else {
                 logger.info(`Process ${id} no longer running during delay. Halting next step.`);
            }
        }, Math.max(1000, currentDelay));
        return; // Salir de la iteración while, la recursión o el timeout se encargarán del siguiente
      }
    }

    if (process.status === 'running' && process.currentIndex >= process.totalCount) {
      this.updateProcess(id, {
        status: 'completed',
        completedAt: new Date().toISOString()
      });
      logger.info(`Bulk sending process ${id} completed. Total: ${process.totalCount}, Success: ${process.successCount}, Fail: ${process.failureCount}.`);
    } else {
      logger.info(`Bulk sending process ${id} ended with status ${process.status}. Current index: ${process.currentIndex} of ${process.totalCount}`);
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getMimeType(filePathOrUrl) {
    const ext = path.extname(filePathOrUrl).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  getFileName(filePathOrUrl) {
    try {
        const url = new URL(filePathOrUrl);
        let name = path.basename(decodeURIComponent(url.pathname));
        if (!path.extname(name) && this.getMimeType(name) === 'application/octet-stream') { // Si no hay extensión, tratar de añadirla
            const possibleExt = Object.keys(mimeTypes).find(key => mimeTypes[key] === this.getMimeType(filePathOrUrl));
            if (possibleExt) name += possibleExt;
        }
        return name || `document${path.extname(url.pathname) || '.dat'}`;
    } catch (e) {
        return path.basename(filePathOrUrl) || `document${path.extname(filePathOrUrl) || '.dat'}`;
    }
  }

  broadcastUpdate(processData) {
    const minimalProcessData = {
        id: processData.id, status: processData.status,
        currentIndex: processData.currentIndex, totalCount: processData.totalCount,
        successCount: processData.successCount, failureCount: processData.failureCount,
        progress: processData.totalCount > 0 ? Math.round((processData.currentIndex / processData.totalCount) * 100) : 0,
        startedAt: processData.startedAt, completedAt: processData.completedAt,
        scheduledTime: processData.scheduledTime,
    };
    const update = { type: 'process_update', data: minimalProcessData };
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        try { client.send(JSON.stringify(update)); } catch (e) { logger.error('Error broadcasting update:', e); }
      }
    });
  }

  setupCleanupJob() {
    cron.schedule('0 */2 * * *', () => { // Cada 2 horas
      const now = Date.now();
      const maxAgeCompleted = 24 * 60 * 60 * 1000; // 24 horas
      const maxAgeActiveIdle = 6 * 60 * 60 * 1000; // 6 horas
      logger.info('Running cleanup job for old processes...');
      let deletedCount = 0;
      for (const [id, process] of this.processes.entries()) {
        let shouldDelete = false;
        if (['completed', 'failed', 'stopped'].includes(process.status)) {
          if (now - new Date(process.completedAt || process.lastActivity).getTime() > maxAgeCompleted) {
            shouldDelete = true;
          }
        } else if (['running', 'paused', 'scheduled', 'pending'].includes(process.status)) {
          if (now - process.lastActivity > maxAgeActiveIdle) {
            logger.warn(`Process ${id} (${process.status}) idle for too long. Stopping.`);
            if (process.timeout) clearTimeout(process.timeout);
            this.updateProcess(id, { status: 'failed', completedAt: new Date().toISOString(), errors: [...(process.errors || []), 'Process timed out due to inactivity'] });
            // No se borra inmediatamente, se marcará para el siguiente ciclo de limpieza si es necesario.
          }
        }
        if (shouldDelete) {
          this.deleteProcess(id);
          deletedCount++;
        }
      }
      if (deletedCount > 0) logger.info(`Cleanup: Deleted ${deletedCount} old processes.`);
      else logger.info('Cleanup: No old processes to delete this cycle.');
    });
  }

  getProcessStats() {
    const stats = { total: this.processes.size, pending: 0, running: 0, paused: 0, completed: 0, failed: 0, scheduled: 0, stopped: 0 };
    for (const process of this.processes.values()) {
      stats[process.status] = (stats[process.status] || 0) + 1;
    }
    return stats;
  }

  getAllProcesses() {
    return Array.from(this.processes.values()).map(p => ({
        id: p.id, status: p.status, currentIndex: p.currentIndex, totalCount: p.totalCount,
        successCount: p.successCount, failureCount: p.failureCount, scheduledTime: p.scheduledTime,
        startedAt: p.startedAt, completedAt: p.completedAt,
        progress: p.totalCount > 0 ? Math.round((p.currentIndex / p.totalCount) * 100) : 0,
        errorCount: p.errors?.length || 0, lastActivity: p.lastActivity
    })).sort((a,b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }
}

const bulkManager = new BulkSendingManager();

// API Routes
app.post('/api/upload-excel', upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        await fs.unlink(req.file.path);
        return res.status(400).json({ error: 'Excel file contains no sheets.' });
    }
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });

    if (data.length < 2) {
      await fs.unlink(req.file.path);
      return res.status(400).json({ error: 'Excel file must have a header and at least one data row' });
    }

    const headers = data[0].map(h => String(h || '').trim().toLowerCase());
    const rows = data.slice(1);
    const nameHeaderVariations = ['nombre', 'nombres', 'full name', 'name', 'cliente', 'contacto'];
    const phoneHeaderVariationsBase = ['telefono', 'numero', 'celular', 'whatsapp', 'phone', 'móvil', 'movil'];
    let nameColumnIndex = headers.findIndex(h => nameHeaderVariations.includes(h));
    if (nameColumnIndex === -1) nameColumnIndex = 1; // Default B

    let numberColumnIndexes = [];
    const potentialPhoneHeaders = headers.map((h, idx) => ({ header: h, index: idx }))
                                   .filter(hObj => phoneHeaderVariationsBase.some(base => hObj.header.startsWith(base)));
    if (potentialPhoneHeaders.length > 0) {
        numberColumnIndexes = potentialPhoneHeaders.map(ph => ph.index);
    } else {
        numberColumnIndexes = [3, 4, 5]; // Default D, E, F
        logger.warn('Phone columns not auto-detected well, using defaults D,E,F. Headers found:', headers);
    }
    if (nameColumnIndex === -1 && numberColumnIndexes.length === 0) {
        await fs.unlink(req.file.path);
        return res.status(400).json({ error: "Could not identify 'name' or 'phone' columns. Please check headers."});
    }


    const contacts = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(cell => cell === null || cell === undefined || String(cell).trim() === '')) continue;

      const fullName = row[nameColumnIndex] ? String(row[nameColumnIndex]).trim() : '';
      const firstName = fullName.split(' ')[0] || `Contacto_Fila_${i+2}`;

      if (!firstName && numberColumnIndexes.every(idx => !row[idx] || String(row[idx]).trim() === '')) continue;

      const validNumbers = new Set();
      for (const colIndex of numberColumnIndexes) {
        if (row[colIndex] === undefined || row[colIndex] === null) continue;
        const phoneNumber = String(row[colIndex]).trim().replace(/[^0-9+]/g, '');
        const phoneRegex = /^(\+?51)?9\d{8}$/;
        if (phoneRegex.test(phoneNumber)) {
          let normalizedNumber = phoneNumber;
          if (!normalizedNumber.startsWith('+51')) {
            normalizedNumber = '+51' + normalizedNumber.replace(/^51/, '');
          }
          if (normalizedNumber.match(/^\+519\d{8}$/)) {
            validNumbers.add(normalizedNumber);
          }
        }
      }
      if (validNumbers.size > 0) {
        contacts.push({ name: firstName, numbers: Array.from(validNumbers), rowIndex: i + 2 });
      }
    }
    await fs.unlink(req.file.path);
    res.json({
      success: true,
      data: {
        totalRowsInFile: data.length -1, processedRows: rows.length, validContacts: contacts.length,
        contacts: contacts,
        summary: { totalContactsFound: contacts.length, totalNumbersFound: contacts.reduce((sum, c) => sum + c.numbers.length, 0)}
      }
    });
  } catch (error) {
    logger.error('Excel upload error:', error);
    if (req.file?.path) { try { await fs.unlink(req.file.path); } catch (e) { /* ignore */ } }
    res.status(500).json({ error: `Failed to process Excel file: ${error.message}` });
  }
});

app.post('/api/bulk-send', async (req, res) => {
  try {
    const { error, value } = messageSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });
    if (!global.providerInstance?.vendor?.user) return res.status(400).json({ error: 'WhatsApp is not connected.' });
    if (!value.contacts || value.contacts.length === 0) return res.status(400).json({ error: 'No contacts provided.' });

    const processId = `bulk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const processData = bulkManager.createProcess(processId, value);
    const startedOrScheduled = await bulkManager.startProcess(processId);

    if (startedOrScheduled) {
      res.status(202).json({
        success: true, processId, status: processData.status,
        message: processData.scheduledTime ? `Process ${processId} scheduled for ${new Date(processData.scheduledTime).toLocaleString()}` : `Process ${processId} started`
      });
    } else {
      bulkManager.deleteProcess(processId);
      res.status(409).json({ error: 'Failed to start/schedule process.' });
    }
  } catch (err) {
    logger.error('Critical error in /api/bulk-send:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/process/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const process = bulkManager.getProcess(id);
  if (!process) return res.status(404).json({ error: `Process ${id} not found.` });
  try {
    let result = false; let message = '';
    switch (action) {
      case 'pause': result = await bulkManager.pauseProcess(id); message = `Process ${id} ${result ? 'paused' : 'failed to pause'}.`; break;
      case 'resume': result = await bulkManager.resumeProcess(id); message = `Process ${id} ${result ? 'resumed' : 'failed to resume'}.`; break;
      case 'stop': result = await bulkManager.stopProcess(id); message = `Process ${id} ${result ? 'stopped' : 'failed to stop'}.`; break;
      default: return res.status(400).json({ error: `Invalid action: ${action}` });
    }
    res.json({ success: result, message, processStatus: bulkManager.getProcess(id)?.status });
  } catch (error) {
    logger.error(`Process action '${action}' for '${id}' failed:`, error);
    res.status(500).json({ error: `Server error on action '${action}' for process ${id}.` });
  }
});

app.get('/api/process/:id', (req, res) => {
  const process = bulkManager.getProcess(req.params.id);
  if (!process) return res.status(404).json({ error: 'Process not found' });
  const { contacts, ...summary } = process; // Excluir la lista de contactos
  res.json({ success: true, data: { ...summary, errors: process.errors.slice(-10) }});
});

app.get('/api/processes', (req, res) => {
  res.json({ success: true, data: { list: bulkManager.getAllProcesses(), stats: bulkManager.getProcessStats() } });
});

app.get('/api/qr', async (req, res) => {
  try {
    if (global.providerInstance?.vendor?.user) {
      return res.json({ success: true, authenticated: true, message: "Already authenticated." });
    }
    // Prioritize pairing code if active and available
    if (global.providerInstance?.usePairingCode && global.providerInstance?.pairingCode) {
        return res.json({ success: true, authenticated: false, qr: null, pairingCode: global.providerInstance.pairingCode, message: "Using pairing code." });
    }
    // Fallback to QR image
    const qrPath = path.join(__dirname, 'bot.qr.png');
    try {
      const qrBuffer = await fs.readFile(qrPath);
      res.json({ success: true, authenticated: false, qr: `data:image/png;base64,${qrBuffer.toString('base64')}` });
    } catch (fileError) {
      res.json({ success: true, authenticated: false, qr: null, pairingCodeExpected: !!global.providerInstance?.usePairingCode, message: "QR/Pairing code not available yet." });
    }
  } catch (error) {
    logger.error('QR endpoint error:', error);
    res.status(500).json({ error: 'Internal server error fetching QR status.' });
  }
});

app.get('/api/status', (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  res.json({ success: true, data: {
    whatsapp: {
      connected: !!global.providerInstance?.vendor?.user,
      user: global.providerInstance?.vendor?.user ? { id: global.providerInstance.vendor.user.id, name: global.providerInstance.vendor.user.name } : null,
      providerStatus: global.providerInstance?.getStatus?.() || 'N/A'
    },
    server: {
      uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${Math.floor(uptime%60)}s`,
      memory: { rss: `${(mem.rss/1024/1024).toFixed(2)}MB`, heapUsed: `${(mem.heapUsed/1024/1024).toFixed(2)}MB` },
      nodeVersion: process.version, timezone: TIMEZONE, port: PORT
    },
    processesSummary: bulkManager.getProcessStats()
  }});
});

wss.on('connection', (wsClient) => {
  logger.info('New WebSocket client connected.');
  const sendToClient = (payload) => {
    if (wsClient.readyState === 1) {
      try { wsClient.send(JSON.stringify(payload)); } catch (e) { logger.error("WS send error:", e); }
    }
  };
  sendToClient({ type: 'status_update', data: { connected: !!global.providerInstance?.vendor?.user, user: global.providerInstance?.vendor?.user || null }});
  if (!global.providerInstance?.vendor?.user && global.providerInstance?.pairingCode) {
    sendToClient({ type: 'pairing_code', data: global.providerInstance.pairingCode });
  }

  wsClient.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'get_status':
          sendToClient({ type: 'status_update', data: { connected: !!global.providerInstance?.vendor?.user, user: global.providerInstance?.vendor?.user || null }});
          if (!global.providerInstance?.vendor?.user && global.providerInstance?.pairingCode) {
            sendToClient({ type: 'pairing_code', data: global.providerInstance.pairingCode });
          }
          break;
        case 'request_qr': // This now implies request for QR or Pairing Code
          if (global.providerInstance?.usePairingCode && global.providerInstance?.pairingCode) {
            sendToClient({ type: 'pairing_code', data: global.providerInstance.pairingCode, message: "Using pairing code." });
          } else {
            try {
              const qrPath = path.join(__dirname, 'bot.qr.png');
              const qrBuffer = await fs.readFile(qrPath);
              sendToClient({ type: 'qr_update', data: `data:image/png;base64,${qrBuffer.toString('base64')}` });
            } catch { sendToClient({ type: 'qr_update', data: null, message: "QR not available." }); }
          }
          break;
      }
    } catch (error) {
      logger.error('WS message error:', error);
      sendToClient({ type: 'error', message: 'Invalid message or server error.' });
    }
  });
  wsClient.on('close', (code, reason) => logger.info(`WS client disconnected. Code: ${code}, Reason: ${reason?.toString()?.substring(0,100) || 'N/A'}`));
  wsClient.on('error', (error) => logger.error('WS client error:', error));
});

app.use((error, req, res, next) => {
  logger.error('Unhandled Express Error:', { message: error.message, stack: error.stack.substring(0, 500), url: req.originalUrl });
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: `Upload error: ${error.message}` });
  }
  if (error.isJoi) return res.status(400).json({ error: 'Validation error', details: error.details.map(d => d.message) });
  res.status(error.status || 500).json({ error: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not Found', message: `Route ${req.originalUrl} not found.` }));

const signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(signal => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down...`);
    for (const [id, proc] of bulkManager.processes) {
      if (['running', 'paused', 'scheduled', 'pending'].includes(proc.status)) {
        if (proc.timeout) clearTimeout(proc.timeout);
        bulkManager.updateProcess(id, { status: 'stopped', completedAt: new Date().toISOString() });
        logger.info(`Process ${id} stopped for shutdown.`);
      }
    }
    wss.close(() => logger.info('WebSocket server closed.'));
    server.close(async () => {
      logger.info('HTTP server closed.');
      if (global.providerInstance?.vendor) {
        try { await global.providerInstance.vendor.end(); logger.info('Baileys disconnected.'); }
        catch (e) { logger.error('Error disconnecting Baileys:', e); }
      }
      logger.info('Shutdown complete.');
      process.exit(signals[signal]);
    });
    setTimeout(() => { logger.warn('Forcing exit after timeout.'); process.exit(1); }, 10000);
  });
});

main().then(() => {
  server.listen(PORT, () => {
    logger.info(`🚀 Express server running on http://localhost:${PORT}`);
    logger.info(`📱 WhatsApp Bulk Sender (BuilderBot) ready.`);
    logger.info(`📊 WebSocket server on ws://localhost:${PORT}`);
    const authMethod = global.providerInstance?.usePairingCode ?
      (process.env.PHONE_NUMBER ? `Pairing Code for ${process.env.PHONE_NUMBER} (if requested/no session)` : 'Pairing Code (if no session, check console/UI)')
      : 'QR Scan (if no session, bot.qr.png will be generated)';
    logger.info(`🔑 Auth method: ${authMethod}`);
  });
}).catch(error => {
  logger.error('❌ Server failed to start:', error);
  process.exit(1);
});