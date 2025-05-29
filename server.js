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
import QRCode from 'qrcode';
import cron from 'node-cron';
import winston from 'winston';
import Joi from 'joi';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import moment from 'moment-timezone';
import dotenv from 'dotenv';

// BuilderBot imports
import { createBot, createProvider, createFlow } from '@builderbot/bot';
import BaileysProvider from '@builderbot/provider-baileys';
import { JsonFileDB } from '@builderbot/database-json'; // <--- MODIFICACIÓN AQUÍ: Nombre y sigue siendo nombrada

// Environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Lima';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SESSIONS_DIR = './baileys_auth_info'; // Usado por BaileysProvider internamente
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
  fs.mkdir('./public', { recursive: true })
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
// ... (sin cambios en multer) ...
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
// ... (sin cambios en Joi schema) ...
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
const flowWelcome = createFlow([]);

const main = async () => {
  // MODIFICACIÓN AQUÍ: Usar JsonFileDB y pasarle la configuración
  const database = new JsonFileDB({ filename: DB_PATH });
  logger.info(`Database adapter initialized with file: ${DB_PATH}`);

  const provider = createProvider(BaileysProvider, {
    name: 'whatsapp-bulk-sender',
    gifPlayback: false,
    timeRelease: 10800000,
    usePairingCode: true,
    phoneNumber: process.env.PHONE_NUMBER || null
  });

  provider.on('require_action', ({ qr, code }) => {
    if (qr) {
        logger.info('QR Code received for authentication. Check bot.qr.png or /api/qr endpoint.');
    }
    if (code) {
        logger.info(`Pairing Code: ${code}. Please enter this code on your WhatsApp linked devices screen.`);
        // Broadcast pairing code if UI can handle it
        wss.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(JSON.stringify({ type: 'pairing_code', data: code }));
            }
        });
    }
  });

  provider.on('ready', () => {
    logger.info('WhatsApp Provider is ready!');
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: 'status_update',
                data: {
                    connected: true,
                    user: global.providerInstance?.vendor?.user || null
                }
            }));
        }
    });
  });

  provider.on('auth_failure', (error) => {
    logger.error('WhatsApp Authentication Failure:', error);
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
    flow: createFlow([flowWelcome]), // Asegúrate que createFlow envuelva el array de flujos
    database,
    provider
  });

  global.botInstance = bot;
  global.providerInstance = botProvider;

  return { bot, provider: botProvider };
};

// BulkSendingManager Class (sin cambios internos, solo el getAllProcesses ya estaba bien)
// ... (BulkSendingManager class y sus métodos permanecen igual que en la última versión que te di)
class BulkSendingManager {
  constructor() {
    this.processes = new Map();
    this.setupCleanupJob();
  }

  createProcess(id, data) {
    const process = {
      id,
      status: 'pending', // pending, running, paused, completed, failed, stopped, scheduled
      currentIndex: 0,
      totalCount: data.contacts.length,
      contacts: data.contacts,
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
      timeout: null, // For inter-message delay or schedule timeout
      lastActivity: Date.now()
    };

    this.processes.set(id, process);
    logger.info(`Created bulk sending process: ${id}`, { totalContacts: data.contacts.length, scheduled: !!data.scheduledTime });
    this.broadcastUpdate(process); // Broadcast initial state
    return process;
  }

  getProcess(id) {
    return this.processes.get(id);
  }

  updateProcess(id, updates) {
    const process = this.processes.get(id);
    if (process) {
      Object.assign(process, updates, { lastActivity: Date.now() });
      this.broadcastUpdate(process); // Broadcast updates
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
    // Optionally broadcast a delete event if UI needs to react
  }

  async startProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status === 'running' || process.status === 'scheduled') {
        logger.warn(`Process ${id} already running or scheduled, or not found.`);
        return false;
    }

    // Check if scheduled for future
    if (process.scheduledTime && new Date(process.scheduledTime) > new Date()) {
      this.scheduleProcess(id); // This will set status to 'scheduled'
      return true;
    }

    // If it was scheduled and now is the time, or not scheduled at all
    this.updateProcess(id, {
      status: 'running',
      startedAt: new Date().toISOString()
    });

    // No need to await executeProcess here, let it run in background
    this.executeProcess(id).catch(err => {
        logger.error(`Unhandled error in executeProcess for ${id}:`, err);
        this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical error: ${err.message}`] });
    });
    return true;
  }

  async pauseProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running') return false;

    if (process.timeout) { // If a delay timeout is active
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
    this.executeProcess(id).catch(err => { // Resume execution
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
    const finalStatus = process.status === 'scheduled' ? 'stopped' : (process.currentIndex > 0 ? 'stopped' : 'failed');

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
        logger.info(`Scheduled time reached for process ${id}. Starting...`);
        this.updateProcess(id, { status: 'pending', scheduledTime: null }); 
        await this.startProcess(id); 
      }, delayMs);

      this.updateProcess(id, { status: 'scheduled' });
      logger.info(`Scheduled process ${id} for ${process.scheduledTime}. Will start in ${delayMs / 1000}s.`);
    } else {
      logger.info(`Scheduled time for process ${id} is in the past. Starting immediately.`);
      this.updateProcess(id, { scheduledTime: null }); 
      this.startProcess(id);
    }
  }

  async executeProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running' || !global.providerInstance || !global.providerInstance.vendor) {
        logger.warn(`Process ${id} cannot execute. Status: ${process?.status}, Provider ready: ${!!global.providerInstance?.vendor}`);
        if(process && process.status === 'running') this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), 'Provider not ready or process status invalid'] });
        return;
    }

    const { contacts, messageTemplate, delay, mediaUrl, mediaType } = process;

    while (process.currentIndex < process.totalCount && process.status === 'running') {
      const contact = contacts[process.currentIndex];
      const personalizedMessage = messageTemplate.replace(/{nombre}/g, contact.name || ''); 

      let successfulSendsThisContact = 0;
      let errorsThisContact = [];

      for (const number of contact.numbers) {
        if (process.status !== 'running') break; 

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
             if(mediaType !== 'audio' && !messagePayload.text && Object.keys(messagePayload).length === 0) { 
                messagePayload.text = personalizedMessage; 
             }

          } else {
            messagePayload = { text: personalizedMessage };
          }


          const sendResult = await global.providerInstance.vendor.sendMessage(formattedNumber, messagePayload);
          logger.info(`Message sent to ${number} (contact: ${contact.name}, row: ${contact.rowIndex}). ID: ${sendResult.key?.id}. Process: ${id}`);
          successfulSendsThisContact++;

          await global.providerInstance.vendor.sendPresenceUpdate('available', formattedNumber);

        } catch (error) {
          logger.error(`Failed to send to ${number} (contact: ${contact.name}, row: ${contact.rowIndex}). Process: ${id}:`, error.message);
          errorsThisContact.push(`Failed for ${number}: ${error.message.substring(0, 100)}`);
        }
        if (contact.numbers.length > 1 && process.status === 'running') {
             await this.delay(Math.max(500, delay / 5) + Math.random() * 300); 
        }
      } 

      if (process.status !== 'running') break; 

      if (successfulSendsThisContact > 0) {
        process.successCount++;
      } else {
        process.failureCount++;
        process.errors.push(...errorsThisContact.map(e => `Row ${contact.rowIndex} (${contact.name}): ${e}`));
      }

      process.currentIndex++;
      this.updateProcess(id, { 
        currentIndex: process.currentIndex,
        successCount: process.successCount,
        failureCount: process.failureCount,
        errors: process.errors
      });

      logger.info(`Process ${id} progress: ${process.currentIndex}/${process.totalCount}. Success: ${process.successCount}, Fail: ${process.failureCount}`);

      if (process.currentIndex < process.totalCount && process.status === 'running') {
        const currentDelay = delay + (Math.random() * (delay * 0.2) - (delay * 0.1)); 
        await new Promise(resolve => {
          process.timeout = setTimeout(resolve, Math.max(1000, currentDelay)); 
        });
        process.timeout = null;
      }
    } 

    if (process.status === 'running') { 
      this.updateProcess(id, {
        status: 'completed',
        completedAt: new Date().toISOString()
      });
      logger.info(`Bulk sending process ${id} completed. Total: ${process.totalCount}, Success: ${process.successCount}, Fail: ${process.failureCount}.`);
    } else {
      logger.info(`Bulk sending process ${id} ended with status ${process.status}. Current index: ${process.currentIndex}`);
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getMimeType(filePathOrUrl) {
    const ext = path.extname(filePathOrUrl).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  getFileName(filePathOrUrl) {
    try {
        const url = new URL(filePathOrUrl);
        return path.basename(url.pathname) || `document${path.extname(url.pathname) || '.dat'}`;
    } catch (e) { 
        return path.basename(filePathOrUrl) || `document${path.extname(filePathOrUrl) || '.dat'}`;
    }
  }


  broadcastUpdate(processData) {
    const minimalProcessData = {
        id: processData.id,
        status: processData.status,
        currentIndex: processData.currentIndex,
        totalCount: processData.totalCount,
        successCount: processData.successCount,
        failureCount: processData.failureCount,
        progress: processData.totalCount > 0 ? Math.round((processData.currentIndex / processData.totalCount) * 100) : 0,
        startedAt: processData.startedAt,
        completedAt: processData.completedAt,
        scheduledTime: processData.scheduledTime,
    };

    const update = {
      type: 'process_update',
      data: minimalProcessData
    };

    wss.clients.forEach(client => {
      if (client.readyState === 1) { 
        try {
            client.send(JSON.stringify(update));
        } catch (e) {
            logger.error('Error broadcasting update to client:', e);
        }
      }
    });
  }

  setupCleanupJob() {
    cron.schedule('0 * * * *', () => {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; 
      const runningMaxIdle = 6 * 60 * 60 * 1000; 

      logger.info('Running cleanup job for old processes...');
      let deletedCount = 0;

      for (const [id, process] of this.processes.entries()) {
        let shouldDelete = false;
        if (['completed', 'failed', 'stopped'].includes(process.status)) {
          if (now - new Date(process.completedAt || process.lastActivity).getTime() > maxAge) {
            shouldDelete = true;
          }
        } else if (['running', 'paused', 'scheduled', 'pending'].includes(process.status)) {
          if (now - process.lastActivity > runningMaxIdle) {
            logger.warn(`Process ${id} with status ${process.status} has been idle for too long. Stopping and marking for deletion.`);
            if (process.timeout) clearTimeout(process.timeout);
            this.updateProcess(id, { status: 'failed', completedAt: new Date().toISOString(), errors: [...(process.errors || []), 'Process timed out due to inactivity'] });
          }
        }

        if (shouldDelete) {
          this.deleteProcess(id);
          deletedCount++;
        }
      }
      if (deletedCount > 0) {
        logger.info(`Cleanup job: Deleted ${deletedCount} old processes.`);
      } else {
        logger.info('Cleanup job: No old processes found to delete.');
      }
    });
  }

  getProcessStats() {
    const stats = {
      total: this.processes.size,
      pending: 0,
      running: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      scheduled: 0,
      stopped: 0
    };

    for (const process of this.processes.values()) {
      stats[process.status] = (stats[process.status] || 0) + 1;
    }
    return stats;
  }

  getAllProcesses() {
    return Array.from(this.processes.values()).map(p => ({ 
        id: p.id,
        status: p.status,
        currentIndex: p.currentIndex,
        totalCount: p.totalCount,
        successCount: p.successCount,
        failureCount: p.failureCount,
        scheduledTime: p.scheduledTime,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
        progress: p.totalCount > 0 ? Math.round((p.currentIndex / p.totalCount) * 100) : 0,
        errorCount: p.errors?.length || 0,
        lastActivity: p.lastActivity 
    })).sort((a,b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }
}

const bulkManager = new BulkSendingManager();

// API Routes
// ... (sin cambios en las rutas API, usar la versión completa que ya te di)
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

    const headers = data[0].map(h => String(h).trim().toLowerCase()); 
    const rows = data.slice(1);

    const nameHeaderVariations = ['nombre', 'nombres', 'full name', 'name', 'cliente'];
    const phoneHeaderVariationsBase = ['telefono', 'numero', 'celular', 'whatsapp', 'phone'];

    let nameColumnIndex = 1; 
    let numberColumnIndexes = [3, 4, 5]; 

    const detectedNameCol = headers.findIndex(h => nameHeaderVariations.includes(h));
    if (detectedNameCol !== -1) nameColumnIndex = detectedNameCol;
    else logger.warn('Name column not auto-detected by header, using default B. Headers found:', headers);

    const detectedNumberCols = [];
    for (let i = 1; i <= 5; i++) { 
        const variations = phoneHeaderVariationsBase.map(b => `${b}${i}`);
        const colIndex = headers.findIndex(h => variations.includes(h) || phoneHeaderVariationsBase.includes(h) && detectedNumberCols.length === (i-1)); 
        if (colIndex !== -1 && !detectedNumberCols.includes(colIndex)) {
            detectedNumberCols.push(colIndex);
        }
    }
    if (detectedNumberCols.length > 0) numberColumnIndexes = detectedNumberCols;
    else logger.warn('Number columns not auto-detected, using defaults D,E,F. Headers found:', headers);


    const contacts = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(cell => cell === null || cell === undefined || String(cell).trim() === '')) continue; 

      const fullName = row[nameColumnIndex] ? String(row[nameColumnIndex]).trim() : '';
      const firstName = fullName.split(' ')[0] || `Contacto_Fila_${i+2}`; 

      if (!firstName && numberColumnIndexes.every(idx => !row[idx] || String(row[idx]).trim() === '')) {
          continue; 
      }

      const validNumbers = new Set(); 

      for (const colIndex of numberColumnIndexes) {
        if (row[colIndex] === undefined || row[colIndex] === null) continue;
        const phoneNumber = String(row[colIndex]).trim().replace(/[^0-9+]/g, ''); 

        const phoneRegex = /^(\+?51)?9\d{8}$/; 
        const generalPhoneRegex = /^\+?\d{10,15}$/; 

        if (phoneRegex.test(phoneNumber)) {
          let normalizedNumber = phoneNumber;
          if (!normalizedNumber.startsWith('+51')) {
            normalizedNumber = '+51' + normalizedNumber.replace(/^51/, '');
          }
          if (normalizedNumber.match(/^\+519\d{8}$/)) { 
            validNumbers.add(normalizedNumber);
          }
        } else if (generalPhoneRegex.test(phoneNumber)) {
        }
      }

      if (validNumbers.size > 0) {
        contacts.push({
          name: firstName,
          numbers: Array.from(validNumbers),
          rowIndex: i + 2 
        });
      }
    }

    await fs.unlink(req.file.path); 

    res.json({
      success: true,
      data: {
        totalRowsInFile: data.length -1, 
        processedRows: rows.length, 
        validContacts: contacts.length,
        contacts: contacts, 
        summary: {
          totalContactsFound: contacts.length,
          totalNumbersFound: contacts.reduce((sum, c) => sum + c.numbers.length, 0)
        }
      }
    });

  } catch (error) {
    logger.error('Excel upload error:', error);
    if (req.file && req.file.path) { 
        try { await fs.unlink(req.file.path); } catch (e) { logger.warn('Could not delete temp upload file after error:', e);}
    }
    res.status(500).json({ error: `Failed to process Excel file: ${error.message}` });
  }
});

app.post('/api/bulk-send', async (req, res) => {
  try {
    const { error, value } = messageSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });
    }

    if (!global.providerInstance?.vendor?.user) {
      return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR or authenticate.' });
    }
    if (!value.contacts || value.contacts.length === 0) {
        return res.status(400).json({ error: 'No contacts provided for bulk sending.' });
    }


    const processId = `bulk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const processData = bulkManager.createProcess(processId, value); 

    const startedOrScheduled = await bulkManager.startProcess(processId);

    if (startedOrScheduled) {
      res.status(202).json({ 
        success: true,
        processId,
        status: processData.status, 
        message: processData.scheduledTime ? `Process ${processId} scheduled successfully for ${new Date(processData.scheduledTime).toLocaleString()}` : `Process ${processId} started successfully`
      });
    } else {
      bulkManager.deleteProcess(processId); 
      res.status(409).json({ error: 'Failed to start or schedule process. It might be conflicting or in an invalid state.' });
    }

  } catch (err) { 
    logger.error('Critical error in /api/bulk-send:', err);
    res.status(500).json({ error: 'Internal server error during bulk send setup.' });
  }
});

app.post('/api/process/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const process = bulkManager.getProcess(id);

  if (!process) {
    return res.status(404).json({ error: `Process ${id} not found.` });
  }

  try {
    let result = false;
    let message = '';

    switch (action) {
      case 'pause':
        result = await bulkManager.pauseProcess(id);
        message = result ? `Process ${id} paused.` : `Failed to pause process ${id}.`;
        break;
      case 'resume':
        result = await bulkManager.resumeProcess(id);
        message = result ? `Process ${id} resumed.` : `Failed to resume process ${id}.`;
        break;
      case 'stop':
        result = await bulkManager.stopProcess(id);
        message = result ? `Process ${id} stopped.` : `Failed to stop process ${id}.`;
        break;
      default:
        return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    if (result) {
        res.json({ success: true, message, processStatus: bulkManager.getProcess(id)?.status });
    } else {
        res.status(400).json({ success: false, error: message, processStatus: bulkManager.getProcess(id)?.status });
    }
  } catch (error) {
    logger.error(`Process action '${action}' for ID '${id}' failed:`, error);
    res.status(500).json({ error: `Internal server error while performing action '${action}' on process ${id}.` });
  }
});

app.get('/api/process/:id', (req, res) => {
  const process = bulkManager.getProcess(req.params.id);
  if (!process) {
    return res.status(404).json({ error: 'Process not found' });
  }
  const processSummary = {
      id: process.id,
      status: process.status,
      currentIndex: process.currentIndex,
      totalCount: process.totalCount,
      successCount: process.successCount,
      failureCount: process.failureCount,
      scheduledTime: process.scheduledTime,
      startedAt: process.startedAt,
      completedAt: process.completedAt,
      errors: process.errors.slice(-10) 
  };
  res.json({ success: true, data: processSummary });
});

app.get('/api/processes', (req, res) => {
  const processesList = bulkManager.getAllProcesses(); 
  const stats = bulkManager.getProcessStats();
  res.json({ success: true, data: { list: processesList, stats: stats } });
});


app.get('/api/qr', async (req, res) => {
  try {
    if (global.providerInstance?.vendor?.user) { 
      res.json({ success: true, authenticated: true, message: "Already authenticated." });
    } else {
      const qrPath = path.join(__dirname, 'bot.qr.png'); 
      try {
        await fs.access(qrPath); 
        const qrBuffer = await fs.readFile(qrPath);
        const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
        res.json({ success: true, authenticated: false, qr: qrDataUrl });
      } catch (fileError) {
        if (global.providerInstance && typeof global.providerInstance.requestPairingCode === 'function' && global.providerInstance.usePairingCode) {
             res.json({ success: true, authenticated: false, qr: null, pairingCodeExpected: true, message: "Pairing code might be active. Check server logs or UI." });
        } else {
            res.json({ success: true, authenticated: false, qr: null, message: "QR code not available yet. Waiting for generation..." });
        }
      }
    }
  } catch (error) {
    logger.error('QR endpoint error:', error);
    res.status(500).json({ error: 'Internal server error while fetching QR status.' });
  }
});

app.get('/api/status', (req, res) => {
  const uptimeInSeconds = process.uptime();
  const uptimeFormatted = `${Math.floor(uptimeInSeconds / 3600)}h ${Math.floor((uptimeInSeconds % 3600) / 60)}m ${Math.floor(uptimeInSeconds % 60)}s`;

  const memoryUsage = process.memoryUsage();
  const memoryFormatted = {
    rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
    heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
    heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`,
  };

  const status = {
    whatsapp: {
      connected: !!global.providerInstance?.vendor?.user,
      user: global.providerInstance?.vendor?.user ? {
          id: global.providerInstance.vendor.user.id,
          name: global.providerInstance.vendor.user.name || global.providerInstance.vendor.user.verifiedName
      } : null,
      providerStatus: global.providerInstance?.getStatus?.() || 'N/A' 
    },
    server: {
      uptime: uptimeFormatted,
      memory: memoryFormatted,
      nodeVersion: process.version,
      timezone: TIMEZONE,
      port: PORT
    },
    processesSummary: bulkManager.getProcessStats() 
  };

  res.json({ success: true, data: status });
});

// WebSocket handling
// ... (sin cambios en WebSocket handling, usar la versión completa que ya te di)
wss.on('connection', (wsClient) => {
  logger.info('New WebSocket client connected.');

  try {
      wsClient.send(JSON.stringify({
          type: 'status_update', 
          data: {
              connected: !!global.providerInstance?.vendor?.user,
              user: global.providerInstance?.vendor?.user || null
          }
      }));
  } catch (e) { logger.error("Error sending initial status to new WS client", e); }


  wsClient.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString()); 
      logger.debug('WebSocket message received:', data);

      switch (data.type) {
        case 'get_status': 
          wsClient.send(JSON.stringify({
            type: 'status_update',
            data: {
              connected: !!global.providerInstance?.vendor?.user,
              user: global.providerInstance?.vendor?.user || null
            }
          }));
          break;

        case 'request_qr': 
          try {
            const qrPath = path.join(__dirname, 'bot.qr.png');
            const qrBuffer = await fs.readFile(qrPath);
            const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
            wsClient.send(JSON.stringify({ type: 'qr_update', data: qrDataUrl }));
          } catch { 
            wsClient.send(JSON.stringify({ type: 'qr_update', data: null, message: "QR not available." }));
          }
          break;
      }
    } catch (error) {
      logger.error('WebSocket message processing error:', error);
      try {
        wsClient.send(JSON.stringify({ type: 'error', message: 'Invalid message format or server error.' }));
      } catch (e) { logger.error("Error sending error message to WS client", e); }
    }
  });

  wsClient.on('close', (code, reason) => {
    logger.info(`WebSocket client disconnected. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
  });

  wsClient.on('error', (error) => {
    logger.error('WebSocket client error:', error);
  });
});

// Error handling middleware (must be last app.use())
// ... (sin cambios en error handling middleware, usar la versión completa que ya te di)
app.use((error, req, res, next) => {
  logger.error('Unhandled Express Error:', {
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method
  });

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` }); 
    }
    return res.status(400).json({ error: `File upload error: ${error.message}`});
  }

  if (error.isJoi) { 
    return res.status(400).json({ error: 'Validation error', details: error.details.map(d => d.message) });
  }

  res.status(error.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error'
  });
});

// 404 handler for undefined routes
// ... (sin cambios en 404 handler, usar la versión completa que ya te di)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `The requested URL ${req.originalUrl} was not found on this server.` });
});


// Graceful shutdown
// ... (sin cambios en graceful shutdown, usar la versión completa que ya te di)
const signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(signal => {
    process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down gracefully...`);

        logger.info('Stopping active bulk processes...');
        for (const [id, processItem] of bulkManager.processes) {
            if (['running', 'paused', 'scheduled', 'pending'].includes(processItem.status)) {
                if (processItem.timeout) clearTimeout(processItem.timeout);
                bulkManager.updateProcess(id, { status: 'stopped', completedAt: new Date().toISOString() });
                logger.info(`Process ${id} marked as stopped due to server shutdown.`);
            }
        }

        wss.close(err => {
            if (err) {
                logger.error('Error closing WebSocket server:', err);
            } else {
                logger.info('WebSocket server closed.');
            }

            server.close(async (err_http) => {
                if (err_http) {
                    logger.error('Error closing HTTP server:', err_http);
                } else {
                    logger.info('HTTP server closed.');
                }

                if (global.providerInstance && global.providerInstance.vendor) {
                    logger.info('Disconnecting WhatsApp (Baileys)...');
                    try {
                        await global.providerInstance.vendor.end(); 
                        logger.info('WhatsApp (Baileys) disconnected.');
                    } catch (e) {
                        logger.error('Error disconnecting Baileys:', e);
                    }
                }
                logger.info('Shutdown complete.');
                process.exit(signals[signal]); 
            });
        });

        setTimeout(() => {
            logger.warn('Graceful shutdown timed out. Forcing exit.');
            process.exit(1);
        }, 10000); 
    });
});


// Initialize BuilderBot and start server
main().then(() => {
  server.listen(PORT, () => {
    logger.info(`🚀 Servidor Express corriendo en http://localhost:${PORT}`);
    logger.info(`📱 WhatsApp Bulk Sender (BuilderBot Edition) listo.`);
    logger.info(`📊 Servidor WebSocket escuchando en ws://localhost:${PORT}`);
    if(process.env.PHONE_NUMBER){
        logger.info(`📞 Pairing Code para el número: ${process.env.PHONE_NUMBER} (si se solicita).`);
    } else if (global.providerInstance?.usePairingCode) { // Verificar si usePairingCode está configurado en la instancia del provider
        logger.info('📱 Pairing Code se utilizará (si no hay sesión previa). Esperando el código en la consola...');
    } else {
        logger.info('📱 Escanee el código QR (si no hay sesión previa). El archivo bot.qr.png se generará.');
    }
  });
}).catch(error => {
  logger.error('❌ Fallo al iniciar el servidor:', error);
  process.exit(1);
});