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
import JsonFileAdapter from '@builderbot/database-json';

// Environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Lima';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SESSIONS_DIR = './baileys_auth_info';
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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"], // Added unpkg.com for client-side libraries if needed by index.html
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"] // Added blob: for potential image previews or uploads
    }
  }
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', `http://localhost:${PORT}`], // Ensure dynamic PORT is covered
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
  mediaUrl: Joi.string().uri({ scheme: ['http', 'https'] }).allow('').optional(), // Allow empty string and ensure scheme
  mediaType: Joi.string().valid('image', 'video', 'document', 'audio').allow('').optional(), // Allow empty string
  scheduledTime: Joi.date().greater('now').optional()
});

// BuilderBot setup
const flowWelcome = createFlow([]); // Empty flow, as this is primarily a bulk sender

const main = async () => {
  const database = new JsonFileAdapter();
  const provider = createProvider(BaileysProvider, {
    name: 'whatsapp-bulk-sender', // Consistent name
    gifPlayback: false,
    timeRelease: 10800000, // 3 hours, Baileys default for cleaning store
    usePairingCode: true, // Using pairing code method
    phoneNumber: process.env.PHONE_NUMBER || null // For pairing code if needed
  });

  // Listener for QR or Pairing Code from BaileysProvider
  provider.on('require_action', ({ qr, code }) => {
    if (qr) {
        logger.info('QR Code received for authentication.');
        // The QR image 'bot.qr.png' will be generated by BaileysProvider in the root.
        // The /api/qr endpoint will serve this.
    }
    if (code) {
        logger.info(`Pairing Code: ${code}`);
        // Potentially broadcast this code via WebSocket if a UI element can display it.
        // For now, it's logged. The /api/qr will handle auth status.
    }
  });

  provider.on('ready', () => {
    logger.info('WhatsApp Provider is ready!');
    // Broadcast ready status via WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
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
        if (client.readyState === 1) { // WebSocket.OPEN
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
    flow: flowWelcome,
    database,
    provider
  });

  // Global bot instance
  global.botInstance = bot;
  global.providerInstance = botProvider; // This is the initialized provider instance

  return { bot, provider: botProvider };
};

// Bulk sending process state
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
    // Note: Pausing doesn't clear scheduledTime if it was a future scheduled task that got paused after starting.
    // This logic assumes pause is for an actively running (message-by-message) process.
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
      status: finalStatus, // or 'failed' if it never truly started any sending
      completedAt: new Date().toISOString() // Using completedAt to signify when it was stopped
    });
    logger.info(`Stopped bulk sending process: ${id}`);
    return true;
  }

  scheduleProcess(id) {
    const process = this.getProcess(id);
    if (!process || !process.scheduledTime) return;

    const delayMs = new Date(process.scheduledTime).getTime() - new Date().getTime();

    if (delayMs > 0) {
      if (process.timeout) clearTimeout(process.timeout); // Clear existing timeout if any

      process.timeout = setTimeout(async () => {
        logger.info(`Scheduled time reached for process ${id}. Starting...`);
        // Update status from 'scheduled' to 'pending' or directly 'running' before startProcess
        this.updateProcess(id, { status: 'pending', scheduledTime: null }); // Clear scheduledTime as it's now due
        await this.startProcess(id); // This will set it to 'running' and execute
      }, delayMs);

      this.updateProcess(id, { status: 'scheduled' });
      logger.info(`Scheduled process ${id} for ${process.scheduledTime}. Will start in ${delayMs / 1000}s.`);
    } else {
      // If scheduled time is in the past, start immediately
      logger.info(`Scheduled time for process ${id} is in the past. Starting immediately.`);
      this.updateProcess(id, { scheduledTime: null }); // Clear past schedule
      this.startProcess(id);
    }
  }

  async executeProcess(id) {
    const process = this.getProcess(id);
    // Ensure it's still supposed to be running and provider is available
    if (!process || process.status !== 'running' || !global.providerInstance || !global.providerInstance.vendor) {
        logger.warn(`Process ${id} cannot execute. Status: ${process?.status}, Provider ready: ${!!global.providerInstance?.vendor}`);
        if(process && process.status === 'running') this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), 'Provider not ready or process status invalid'] });
        return;
    }

    const { contacts, messageTemplate, delay, mediaUrl, mediaType } = process;

    while (process.currentIndex < process.totalCount && process.status === 'running') {
      const contact = contacts[process.currentIndex];
      const personalizedMessage = messageTemplate.replace(/{nombre}/g, contact.name || ''); // Handle if name is missing

      let successfulSendsThisContact = 0;
      let errorsThisContact = [];

      for (const number of contact.numbers) {
        if (process.status !== 'running') break; // Check status before sending to each number

        try {
          await rateLimiter.consume(number).catch(rlError => { // Consume per number
            logger.warn(`Rate limit exceeded for ${number} in process ${id}: ${rlError.message}`);
            errorsThisContact.push(`Rate limit exceeded for ${number}`);
            throw rlError; // Stop processing this number if rate limited
          });

          const formattedNumber = number.replace(/\+/g, '') + '@s.whatsapp.net';

          const [waCheckResult] = await global.providerInstance.vendor.onWhatsApp(number.replace(/\+/g, ''));
          if (!waCheckResult?.exists) {
            logger.warn(`Number ${number} (contact: ${contact.name}, row: ${contact.rowIndex}) not on WhatsApp. Process: ${id}`);
            errorsThisContact.push(`Number ${number} not on WhatsApp`);
            continue; // Skip to next number for this contact
          }

          await global.providerInstance.vendor.sendPresenceUpdate('composing', formattedNumber);
          await this.delay(500 + Math.random() * 500); // Small random delay

          let messagePayload = {};
          const caption = personalizedMessage; // Use personalized message as caption by default

          if (mediaUrl && mediaType) {
            switch (mediaType) {
              case 'image': messagePayload = { image: { url: mediaUrl }, caption }; break;
              case 'video': messagePayload = { video: { url: mediaUrl }, caption }; break;
              case 'document': messagePayload = { document: { url: mediaUrl }, mimetype: this.getMimeType(mediaUrl), fileName: this.getFileName(mediaUrl), caption }; break;
              case 'audio': messagePayload = { audio: { url: mediaUrl }, mimetype: 'audio/mpeg', ptt: false }; break; // Assuming not PTT by default
              default: messagePayload = { text: personalizedMessage }; // Fallback to text if media type is odd
            }
             if(mediaType !== 'audio' && !messagePayload.text && Object.keys(messagePayload).length === 0) { // If only media, but no text part was set
                messagePayload.text = personalizedMessage; // Ensure text is sent if media payload is empty (e.g. bad type)
             } else if (mediaType === 'audio') {
                 // Audio messages typically don't have a separate caption field in the same way images/videos do with Baileys.
                 // If a caption is desired with audio, it might need to be sent as a subsequent text message.
                 // For simplicity, we don't send a separate caption for audio here.
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
             await this.delay(Math.max(500, delay / 5) + Math.random() * 300); // Shorter delay between numbers of same contact
        }
      } // End loop for contact's numbers

      if (process.status !== 'running') break; // Check status after processing all numbers for a contact

      if (successfulSendsThisContact > 0) {
        process.successCount++;
      } else {
        process.failureCount++;
        process.errors.push(...errorsThisContact.map(e => `Row ${contact.rowIndex} (${contact.name}): ${e}`));
      }

      process.currentIndex++;
      this.updateProcess(id, { // This will also broadcast the update
        currentIndex: process.currentIndex,
        successCount: process.successCount,
        failureCount: process.failureCount,
        errors: process.errors
      });

      logger.info(`Process ${id} progress: ${process.currentIndex}/${process.totalCount}. Success: ${process.successCount}, Fail: ${process.failureCount}`);

      if (process.currentIndex < process.totalCount && process.status === 'running') {
        const currentDelay = delay + (Math.random() * (delay * 0.2) - (delay * 0.1)); // Add jitter to delay
        await new Promise(resolve => {
          process.timeout = setTimeout(resolve, Math.max(1000, currentDelay)); // Ensure minimum 1s
        });
        process.timeout = null;
      }
    } // End while loop for contacts

    if (process.status === 'running') { // If loop finished because all contacts were processed
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
        // Add more as needed
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  getFileName(filePathOrUrl) {
    try {
        const url = new URL(filePathOrUrl);
        return path.basename(url.pathname) || `document${path.extname(url.pathname) || '.dat'}`;
    } catch (e) { // Not a valid URL, assume it's a path
        return path.basename(filePathOrUrl) || `document${path.extname(filePathOrUrl) || '.dat'}`;
    }
  }


  broadcastUpdate(processData) {
    // Avoid circular references or overly large objects in broadcast
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
        // errors: processData.errors.slice(-5) // Maybe only last few errors or just a count
    };

    const update = {
      type: 'process_update',
      data: minimalProcessData
    };

    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
            client.send(JSON.stringify(update));
        } catch (e) {
            logger.error('Error broadcasting update to client:', e);
        }
      }
    });
  }

  setupCleanupJob() {
    // Clean up old, completed/failed/stopped processes every hour
    cron.schedule('0 * * * *', () => {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours for completed/failed/stopped
      const runningMaxIdle = 6 * 60 * 60 * 1000; // 6 hours for running/paused/scheduled without activity

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
            // It will be picked up by the next cleanup cycle for deletion if `completedAt` is old enough,
            // or delete immediately if that's the desired behavior for long-idle ones.
            // For now, let's make it eligible for deletion in the next run if it just got marked 'failed'.
            // If we want to delete immediately after stopping due to long idle:
            // shouldDelete = true;
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

  // Method to get all processes for the UI list
  getAllProcesses() {
    return Array.from(this.processes.values()).map(p => ({ // Return a serializable summary
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
        // Do not include full contacts list or large error arrays here
        errorCount: p.errors?.length || 0
    })).sort((a,b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)); // Sort by last activity, newest first
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
        await fs.unlink(req.file.path); // Clean up uploaded file
        return res.status(400).json({ error: 'Excel file contains no sheets.' });
    }
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });


    if (data.length < 2) { // At least one header row and one data row
      await fs.unlink(req.file.path); // Clean up uploaded file
      return res.status(400).json({ error: 'Excel file must have a header and at least one data row' });
    }

    const headers = data[0].map(h => String(h).trim().toLowerCase()); // Normalize headers
    const rows = data.slice(1);

    // Define flexible column mapping (example: look for 'nombre', 'telefono1', etc.)
    // For simplicity, sticking to fixed indices as per original, but this is an area for improvement.
    const nameHeaderVariations = ['nombre', 'nombres', 'full name', 'name', 'cliente'];
    const phoneHeaderVariationsBase = ['telefono', 'numero', 'celular', 'whatsapp', 'phone'];

    let nameColumnIndex = 1; // Default to B
    let numberColumnIndexes = [3, 4, 5]; // Default to D, E, F

    // Simple dynamic column finding (can be improved)
    const detectedNameCol = headers.findIndex(h => nameHeaderVariations.includes(h));
    if (detectedNameCol !== -1) nameColumnIndex = detectedNameCol;
    else logger.warn('Name column not auto-detected by header, using default B. Headers found:', headers);

    const detectedNumberCols = [];
    for (let i = 1; i <= 5; i++) { // Check for telefono1, telefono2, etc.
        const variations = phoneHeaderVariationsBase.map(b => `${b}${i}`);
        const colIndex = headers.findIndex(h => variations.includes(h) || phoneHeaderVariationsBase.includes(h) && detectedNumberCols.length === (i-1)); // More flexible check
        if (colIndex !== -1 && !detectedNumberCols.includes(colIndex)) {
            detectedNumberCols.push(colIndex);
        }
    }
    if (detectedNumberCols.length > 0) numberColumnIndexes = detectedNumberCols;
    else logger.warn('Number columns not auto-detected, using defaults D,E,F. Headers found:', headers);


    const contacts = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(cell => cell === null || cell === undefined || String(cell).trim() === '')) continue; // Skip genuinely empty rows

      const fullName = row[nameColumnIndex] ? String(row[nameColumnIndex]).trim() : '';
      const firstName = fullName.split(' ')[0] || `Contacto_Fila_${i+2}`; // Use a placeholder if name is blank but numbers exist

      if (!firstName && numberColumnIndexes.every(idx => !row[idx] || String(row[idx]).trim() === '')) {
          continue; // Skip if no name and no numbers
      }

      const validNumbers = new Set(); // Use Set to avoid duplicate numbers for the same contact

      for (const colIndex of numberColumnIndexes) {
        if (row[colIndex] === undefined || row[colIndex] === null) continue;
        const phoneNumber = String(row[colIndex]).trim().replace(/[^0-9+]/g, ''); // Clean aggressively

        const phoneRegex = /^(\+?51)?9\d{8}$/; // Peruvian mobile
        const generalPhoneRegex = /^\+?\d{10,15}$/; // More generic international fallback

        if (phoneRegex.test(phoneNumber)) {
          let normalizedNumber = phoneNumber;
          if (!normalizedNumber.startsWith('+51')) {
            normalizedNumber = '+51' + normalizedNumber.replace(/^51/, '');
          }
          if (normalizedNumber.match(/^\+519\d{8}$/)) { // Final check on normalized
            validNumbers.add(normalizedNumber);
          }
        } else if (generalPhoneRegex.test(phoneNumber)) {
            // If it doesn't match specific Peruvian, but looks like a general valid number
            // logger.warn(`Number ${phoneNumber} for ${firstName} does not match Peruvian format, but accepted as general format.`);
            // validNumbers.add(phoneNumber.startsWith('+') ? phoneNumber : '+' + phoneNumber); // Basic normalization
        }
      }

      if (validNumbers.size > 0) {
        contacts.push({
          name: firstName,
          numbers: Array.from(validNumbers),
          rowIndex: i + 2 // +1 for 0-based index, +1 for header row
        });
      }
    }

    await fs.unlink(req.file.path); // Clean up uploaded file

    // Store all contacts in a temporary cache or directly use them if small enough
    // For this example, we'll send all contacts back.
    // In a real app, for very large files, you might process in chunks or store temporarily.
    req.session = req.session || {}; // Ensure session object exists (if using sessions)
    req.session.uploadedContacts = contacts; // Example of session usage, though not fully implemented here without session middleware

    res.json({
      success: true,
      data: {
        totalRowsInFile: data.length -1, // Total data rows in excel
        processedRows: rows.length, // Rows attempted to process
        validContacts: contacts.length,
        contacts: contacts, // Send all contacts
        // contactsPreview: contacts.slice(0, 10), // For preview
        summary: {
          totalContactsFound: contacts.length,
          totalNumbersFound: contacts.reduce((sum, c) => sum + c.numbers.length, 0)
        }
      }
    });

  } catch (error) {
    logger.error('Excel upload error:', error);
    if (req.file && req.file.path) { // Attempt to clean up if error occurred after upload
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
    const processData = bulkManager.createProcess(processId, value); // value contains validated and structured data

    // startProcess will handle scheduling if scheduledTime is present
    const startedOrScheduled = await bulkManager.startProcess(processId);

    if (startedOrScheduled) {
      res.status(202).json({ // 202 Accepted: request accepted, processing will occur
        success: true,
        processId,
        status: processData.status, // Will be 'scheduled' or 'running' (or 'pending' then 'running')
        message: processData.scheduledTime ? `Process ${processId} scheduled successfully for ${new Date(processData.scheduledTime).toLocaleString()}` : `Process ${processId} started successfully`
      });
    } else {
      // This case might happen if startProcess internally determined not to start (e.g., already running with same unique constraints, though not implemented here)
      bulkManager.deleteProcess(processId); // Clean up the created process if it couldn't be started
      res.status(409).json({ error: 'Failed to start or schedule process. It might be conflicting or in an invalid state.' });
    }

  } catch (err) { // Catch any unexpected errors
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
  // Return a safe summary, not the whole process object with contacts
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
      errors: process.errors.slice(-10) // Last 10 errors
  };
  res.json({ success: true, data: processSummary });
});

// Modified to return list of processes and overall stats
app.get('/api/processes', (req, res) => {
  const processesList = bulkManager.getAllProcesses(); // Get summarized list
  const stats = bulkManager.getProcessStats();
  res.json({ success: true, data: { list: processesList, stats: stats } });
});


app.get('/api/qr', async (req, res) => {
  // This endpoint primarily indicates if already authenticated or serves the QR if not.
  // BuilderBot/Baileys typically handles QR generation to a file `bot.qr.png`.
  try {
    if (global.providerInstance?.vendor?.user) { // Check if WhatsApp client is connected and has user info
      res.json({ success: true, authenticated: true, message: "Already authenticated." });
    } else {
      const qrPath = path.join(__dirname, 'bot.qr.png'); // QR path in root
      try {
        await fs.access(qrPath); // Check if QR file exists
        const qrBuffer = await fs.readFile(qrPath);
        const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
        res.json({ success: true, authenticated: false, qr: qrDataUrl });
      } catch (fileError) {
        // QR file doesn't exist, maybe not generated yet or pairing code is active
        if (global.providerInstance && typeof global.providerInstance.requestPairingCode === 'function' && global.providerInstance.usePairingCode) {
             // If pairing code is used, we might not have a QR.
             // The client should be informed to check logs or a UI element for pairing code if implemented.
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
      providerStatus: global.providerInstance?.getStatus?.() || 'N/A' // If provider has a status method
    },
    server: {
      uptime: uptimeFormatted,
      memory: memoryFormatted,
      nodeVersion: process.version,
      timezone: TIMEZONE,
      port: PORT
    },
    processesSummary: bulkManager.getProcessStats() // Summary of process states
  };

  res.json({ success: true, data: status });
});

// WebSocket handling
wss.on('connection', (wsClient) => {
  logger.info('New WebSocket client connected.');

  // Send initial status on connection
  try {
      wsClient.send(JSON.stringify({
          type: 'status_update', // For WhatsApp connection status
          data: {
              connected: !!global.providerInstance?.vendor?.user,
              user: global.providerInstance?.vendor?.user || null
          }
      }));
  } catch (e) { logger.error("Error sending initial status to new WS client", e); }


  wsClient.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString()); // Ensure message is string
      logger.debug('WebSocket message received:', data);

      switch (data.type) {
        case 'get_status': // Client requests current WhatsApp connection status
          wsClient.send(JSON.stringify({
            type: 'status_update',
            data: {
              connected: !!global.providerInstance?.vendor?.user,
              user: global.providerInstance?.vendor?.user || null
            }
          }));
          break;

        case 'request_qr': // Client explicitly requests a new QR code image data
          try {
            const qrPath = path.join(__dirname, 'bot.qr.png');
            const qrBuffer = await fs.readFile(qrPath);
            const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;
            wsClient.send(JSON.stringify({ type: 'qr_update', data: qrDataUrl }));
          } catch { // QR file not found or error reading
            wsClient.send(JSON.stringify({ type: 'qr_update', data: null, message: "QR not available." }));
          }
          break;
        // Add more message types as needed for UI interaction
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
app.use((error, req, res, next) => {
  logger.error('Unhandled Express Error:', {
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method
  });

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` }); // 413 Payload Too Large
    }
    return res.status(400).json({ error: `File upload error: ${error.message}`});
  }

  if (error.isJoi) { // Joi validation error
    return res.status(400).json({ error: 'Validation error', details: error.details.map(d => d.message) });
  }

  // Default to 500 server error
  res.status(error.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error'
  });
});

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `The requested URL ${req.originalUrl} was not found on this server.` });
});

// Graceful shutdown
const signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(signal => {
    process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down gracefully...`);

        // Stop all running/scheduled processes
        logger.info('Stopping active bulk processes...');
        for (const [id, processItem] of bulkManager.processes) {
            if (['running', 'paused', 'scheduled', 'pending'].includes(processItem.status)) {
                if (processItem.timeout) clearTimeout(processItem.timeout);
                // Update status to 'stopped' or 'failed' to prevent restart and allow cleanup
                bulkManager.updateProcess(id, { status: 'stopped', completedAt: new Date().toISOString() });
                logger.info(`Process ${id} marked as stopped due to server shutdown.`);
            }
        }

        // Close WebSocket server
        wss.close(err => {
            if (err) {
                logger.error('Error closing WebSocket server:', err);
            } else {
                logger.info('WebSocket server closed.');
            }

            // Close HTTP server
            server.close(async (err_http) => {
                if (err_http) {
                    logger.error('Error closing HTTP server:', err_http);
                } else {
                    logger.info('HTTP server closed.');
                }

                // Disconnect Baileys if provider is initialized
                if (global.providerInstance && global.providerInstance.vendor) {
                    logger.info('Disconnecting WhatsApp (Baileys)...');
                    try {
                        await global.providerInstance.vendor.end(); // Or appropriate disconnect method
                        logger.info('WhatsApp (Baileys) disconnected.');
                    } catch (e) {
                        logger.error('Error disconnecting Baileys:', e);
                    }
                }
                logger.info('Shutdown complete.');
                process.exit(signals[signal]); // Exit with signal code
            });
        });

        // Force shutdown if graceful period expires
        setTimeout(() => {
            logger.warn('Graceful shutdown timed out. Forcing exit.');
            process.exit(1);
        }, 10000); // 10 seconds timeout
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
    } else if (global.providerInstance?.usePairingCode) {
        logger.info('📱 Pairing Code se utilizará (si no hay sesión previa). Esperando el código en la consola...');
    } else {
        logger.info('📱 Escanee el código QR (si no hay sesión previa). El archivo bot.qr.png se generará.');
    }
  });
}).catch(error => {
  logger.error('❌ Fallo al iniciar el servidor:', error);
  process.exit(1);
});