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
// import QRCode from 'qrcode'; // No se usa directamente por Baileys con pairing code
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
const SESSIONS_DIR = './baileys_auth_info';
const DB_PATH = './db.json';
const UPLOADS_DIR = './uploads';
const LOGS_DIR = './logs';

const IS_USING_PAIRING_CODE = true; // Basado en tu configuración de BaileysProvider
const EXPECTED_PHONE_NUMBER = process.env.PHONE_NUMBER || null;

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'bulk_send',
  points: 100,
  duration: 3600,
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
  fs.mkdir(LOGS_DIR, { recursive: true })
]);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
app.use(express.static(path.join(__dirname, ''))); // Servir index.html desde la raíz

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
    if (allowedTypes.includes(ext)) cb(null, true);
    else cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
  }
});

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

const flowWelcome = createFlow([]);

const main = async () => {
  const database = new JsonFileDB({ filename: DB_PATH });
  logger.info(`Database adapter initialized with file: ${DB_PATH}`);

  const provider = createProvider(BaileysProvider, {
    name: 'whatsapp-bulk-sender',
    gifPlayback: false,
    timeRelease: 10800000,
    usePairingCode: IS_USING_PAIRING_CODE, // Usar la constante
    phoneNumber: EXPECTED_PHONE_NUMBER
  });

  global.providerInstance = provider; // Asignar la instancia del proveedor a global aquí
                                     // para que el log de inicio pueda acceder a usePairingCode

  provider.on('require_action', ({ qr, code }) => {
    if (code) {
        logger.info(`Pairing Code: ${code}. Please enter this code on your WhatsApp linked devices screen.`);
        if (global.providerInstance) global.providerInstance.pairingCode = code;
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'pairing_code', data: code }));
            }
        });
    } else if (qr) { // Solo si no es pairing code y se recibe un QR (menos probable con usePairingCode=true)
        logger.info('QR Code received for authentication. Check bot.qr.png or /api/qr endpoint.');
        // La UI pedirá el QR a través de /api/qr o WebSocket si este es el caso.
    }
  });

  provider.on('ready', () => {
    logger.info('WhatsApp Provider is ready!');
    if (global.providerInstance) global.providerInstance.pairingCode = null;
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

  // `provider` ya está asignado a global.providerInstance, createBot lo usará.
  const { bot, provider: botProviderFromCreateBot } = await createBot({
    flow: flowWelcome,
    database,
    provider // Pasar la instancia de provider ya creada y asignada a global
  });

  // Aunque createBot devuelve una instancia de provider, la que nos interesa para
  // el pairing code y el estado global es la que creamos con createProvider directamente.
  // Asegurémonos de que global.providerInstance siga siendo la correcta.
  // En la práctica, botProviderFromCreateBot debería ser la misma instancia que 'provider'.
  global.botInstance = bot;
  // global.providerInstance = botProviderFromCreateBot; // Opcional, usualmente son la misma. Mantener la original es más seguro para el pairingCode.

  return { bot, provider: global.providerInstance };
};

class BulkSendingManager {
  constructor() {
    this.processes = new Map();
    this.setupCleanupJob();
  }

  createProcess(id, data) {
    const process = {
      id, status: 'pending', currentIndex: 0, totalCount: data.contacts.length,
      contacts: data.contacts, messageTemplate: data.messageTemplate, delay: data.delay,
      mediaUrl: data.mediaUrl, mediaType: data.mediaType, scheduledTime: data.scheduledTime,
      startedAt: null, completedAt: null, successCount: 0, failureCount: 0,
      errors: [], timeout: null, lastActivity: Date.now()
    };
    this.processes.set(id, process);
    logger.info(`Created bulk process: ${id}`, { contacts: data.contacts.length, scheduled: !!data.scheduledTime });
    this.broadcastUpdate(process);
    return process;
  }

  getProcess(id) { return this.processes.get(id); }

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
    if (process?.timeout) clearTimeout(process.timeout);
    this.processes.delete(id);
    logger.info(`Deleted bulk process: ${id}`);
  }

  async startProcess(id) {
    const process = this.getProcess(id);
    if (!process || ['running', 'scheduled'].includes(process.status)) {
      logger.warn(`Process ${id} can't start: status ${process?.status}.`);
      return false;
    }
    if (process.scheduledTime && new Date(process.scheduledTime) > new Date()) {
      this.scheduleProcess(id);
      return true;
    }
    this.updateProcess(id, { status: 'running', startedAt: new Date().toISOString(), scheduledTime: null });
    this.executeProcess(id).catch(err => {
      logger.error(`ExecuteProcess error for ${id}:`, err);
      this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical: ${err.message}`] });
    });
    return true;
  }

  async pauseProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running') return false;
    if (process.timeout) { clearTimeout(process.timeout); process.timeout = null; }
    this.updateProcess(id, { status: 'paused' });
    logger.info(`Paused bulk process: ${id}`);
    return true;
  }

  async resumeProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'paused') return false;
    this.updateProcess(id, { status: 'running' });
    logger.info(`Resuming bulk process: ${id}`);
    this.executeProcess(id).catch(err => {
      logger.error(`ExecuteProcess (resume) error for ${id}:`, err);
      this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), `Critical (resume): ${err.message}`] });
    });
    return true;
  }

  async stopProcess(id) {
    const process = this.getProcess(id);
    if (!process) return false;
    if (process.timeout) { clearTimeout(process.timeout); process.timeout = null; }
    const finalStatus = (process.status === 'scheduled' || process.currentIndex === 0) ? 'stopped' : 'stopped';
    this.updateProcess(id, { status: finalStatus, completedAt: new Date().toISOString() });
    logger.info(`Stopped bulk process: ${id}`);
    return true;
  }

  scheduleProcess(id) {
    const process = this.getProcess(id);
    if (!process || !process.scheduledTime) return;
    const delayMs = new Date(process.scheduledTime).getTime() - new Date().getTime();
    if (delayMs > 0) {
      if (process.timeout) clearTimeout(process.timeout);
      process.timeout = setTimeout(async () => {
        logger.info(`Scheduled time for process ${id}. Starting...`);
        this.updateProcess(id, { status: 'pending' });
        await this.startProcess(id);
      }, delayMs);
      this.updateProcess(id, { status: 'scheduled' });
      logger.info(`Process ${id} scheduled for ${new Date(process.scheduledTime).toLocaleString()}. Starts in ${Math.round(delayMs/1000)}s.`);
    } else {
      logger.info(`Scheduled time for ${id} is past. Starting now.`);
      this.startProcess(id);
    }
  }

  async executeProcess(id) {
    const process = this.getProcess(id);
    if (!process || process.status !== 'running' || !global.providerInstance?.vendor) {
      logger.warn(`Process ${id} execute halt: Status ${process?.status}, Provider ${!!global.providerInstance?.vendor}`);
      if(process?.status === 'running') this.updateProcess(id, { status: 'failed', errors: [...(process.errors || []), 'Provider/Status invalid for execution'] });
      return;
    }
    const { contacts, messageTemplate, delay, mediaUrl, mediaType } = process;
    if (process.currentIndex >= process.totalCount) { // Double check if already completed
        if (process.status === 'running') {
            this.updateProcess(id, { status: 'completed', completedAt: new Date().toISOString() });
            logger.info(`Process ${id} already at end. Marked completed.`);
        }
        return;
    }
    logger.info(`Executing process ${id}: Contact ${process.currentIndex + 1}/${process.totalCount}`);

    const contact = contacts[process.currentIndex];
    const personalizedMessage = messageTemplate.replace(/{nombre}/g, contact.name || 'Cliente');
    let successfulSendsThisContact = 0;
    let errorsThisContact = [];

    for (const number of contact.numbers) {
      if (process.status !== 'running') { logger.info(`Process ${id} no longer running. Halting sends for ${contact.name}.`); return; }
      try {
        await rateLimiter.consume(number).catch(rlErr => { throw rlErr; });
        const formattedNumber = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        const [waCheck] = await global.providerInstance.vendor.onWhatsApp(formattedNumber.split('@')[0]);
        if (!waCheck?.exists) {
          errorsThisContact.push(`${number}: Not on WhatsApp`);
          logger.warn(`${number} for ${contact.name} (row ${contact.rowIndex}) not on WhatsApp. PID: ${id}`);
          continue;
        }
        await global.providerInstance.vendor.sendPresenceUpdate('composing', formattedNumber);
        await this.delay(Math.random() * 500 + 500); // Random delay

        let payload = { text: personalizedMessage };
        if (mediaUrl && mediaType) {
          const caption = personalizedMessage;
          switch (mediaType) {
            case 'image': payload = { image: { url: mediaUrl }, caption }; break;
            case 'video': payload = { video: { url: mediaUrl }, caption }; break;
            case 'document': payload = { document: { url: mediaUrl }, mimetype: this.getMimeType(mediaUrl), fileName: this.getFileName(mediaUrl), caption }; break;
            case 'audio': payload = { audio: { url: mediaUrl }, mimetype: this.getMimeType(mediaUrl) || 'audio/mpeg', ptt: false }; break;
          }
        }
        await global.providerInstance.vendor.sendMessage(formattedNumber, payload);
        logger.info(`Msg to ${number} (${contact.name}, row ${contact.rowIndex}). PID: ${id}`);
        successfulSendsThisContact++;
        await global.providerInstance.vendor.sendPresenceUpdate('available', formattedNumber);
      } catch (error) {
        logger.error(`Send fail to ${number} (${contact.name}, row ${contact.rowIndex}). PID: ${id}: ${error.message.substring(0,150)}`);
        errorsThisContact.push(`${number}: ${error.message.substring(0,100)}`);
      }
      if (contact.numbers.length > 1 && process.status === 'running') await this.delay(Math.max(300, Math.floor(delay/3)));
    }

    if (process.status !== 'running') { logger.info(`Process ${id} no longer running after contact ${contact.name}.`); return; }

    process.currentIndex++;
    if (successfulSendsThisContact > 0) process.successCount++;
    else {
      process.failureCount++;
      process.errors.push(...errorsThisContact.map(e => `R${contact.rowIndex}(${contact.name}): ${e}`));
    }
    this.updateProcess(id, { currentIndex: process.currentIndex, successCount: process.successCount, failureCount: process.failureCount, errors: process.errors });

    if (process.currentIndex < process.totalCount && process.status === 'running') {
      const nextDelay = Math.max(1000, delay + (Math.random() * delay * 0.2 - delay * 0.1));
      process.timeout = setTimeout(() => {
        if (this.getProcess(id)?.status === 'running') this.executeProcess(id); // Continue
        else logger.info(`Process ${id} not running for next step after delay.`);
      }, nextDelay);
    } else if (process.currentIndex >= process.totalCount && process.status === 'running') {
      this.updateProcess(id, { status: 'completed', completedAt: new Date().toISOString() });
      logger.info(`Bulk process ${id} completed. Sent: ${process.successCount}, Failed: ${process.failureCount}.`);
    }
  }

  delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  getMimeType(filePathOrUrl) {
    const ext = path.extname(filePathOrUrl).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf', '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  getFileName(filePathOrUrl) {
    try {
        const url = new URL(filePathOrUrl);
        let name = path.basename(decodeURIComponent(url.pathname));
        if (!path.extname(name)) {
            const mime = this.getMimeType(filePathOrUrl); // Get mime from full path/URL
            const possibleExt = Object.keys(this.getMimeType('dummy.')).find(key => this.getMimeType('dummy' + key) === mime); // Re-getMimeType to use the internal map
            if (possibleExt) name += possibleExt;
        }
        return name || `document${path.extname(url.pathname) || '.dat'}`;
    } catch (e) {
        return path.basename(filePathOrUrl) || `document${path.extname(filePathOrUrl) || '.dat'}`;
    }
  }

  broadcastUpdate(processData) {
    const minimal = {
        id: processData.id, status: processData.status, currentIndex: processData.currentIndex,
        totalCount: processData.totalCount, successCount: processData.successCount,
        failureCount: processData.failureCount, progress: processData.totalCount > 0 ? Math.round((processData.currentIndex / processData.totalCount) * 100) : 0,
        startedAt: processData.startedAt, completedAt: processData.completedAt, scheduledTime: processData.scheduledTime,
    };
    wss.clients.forEach(c => { if (c.readyState === 1) try {c.send(JSON.stringify({ type: 'process_update', data: minimal }));} catch(e){logger.error('WS Broadcast err:',e)} });
  }

  setupCleanupJob() {
    cron.schedule('0 */2 * * *', () => {
      const now = Date.now(), maxAgeC = 24*3600*1000, maxAgeA = 6*3600*1000;
      logger.info('Cleanup job...'); let deleted = 0;
      this.processes.forEach((p, id) => {
        let del = false;
        if (['completed','failed','stopped'].includes(p.status) && (now - new Date(p.completedAt || p.lastActivity).getTime() > maxAgeC)) del = true;
        else if (['running','paused','scheduled','pending'].includes(p.status) && (now - p.lastActivity > maxAgeA)) {
          logger.warn(`Process ${id} (${p.status}) idle too long. Stopping.`);
          if (p.timeout) clearTimeout(p.timeout);
          this.updateProcess(id, { status: 'failed', completedAt: new Date().toISOString(), errors: [...(p.errors||[]),'Idle timeout']});
        }
        if (del) { this.deleteProcess(id); deleted++; }
      });
      if(deleted) logger.info(`Cleanup: Deleted ${deleted} old processes.`); else logger.info('Cleanup: No processes to delete.');
    });
  }

  getProcessStats() {
    const s = { total:0,pending:0,running:0,paused:0,completed:0,failed:0,scheduled:0,stopped:0 };
    this.processes.forEach(p => { s.total++; s[p.status]=(s[p.status]||0)+1; }); return s;
  }

  getAllProcesses() {
    return Array.from(this.processes.values()).map(p=>({
      id:p.id,status:p.status,currentIndex:p.currentIndex,totalCount:p.totalCount,successCount:p.successCount,
      failureCount:p.failureCount,scheduledTime:p.scheduledTime,startedAt:p.startedAt,completedAt:p.completedAt,
      progress:p.totalCount>0?Math.round((p.currentIndex/p.totalCount)*100):0,errorCount:p.errors?.length||0,lastActivity:p.lastActivity
    })).sort((a,b)=>(b.lastActivity||0)-(a.lastActivity||0));
  }
}
const bulkManager = new BulkSendingManager();

app.post('/api/upload-excel', upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.readFile(req.file.path);
    const wsName = wb.SheetNames[0];
    if (!wsName) { await fs.unlink(req.file.path); return res.status(400).json({ error: 'No sheets in Excel.' }); }
    const ws = wb.Sheets[wsName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    await fs.unlink(req.file.path);

    if (data.length < 2) return res.status(400).json({ error: 'Excel needs header + 1 data row' });
    const headers = data[0].map(h => String(h||'').trim().toLowerCase());
    const rows = data.slice(1);
    const nameH = ['nombre','name','cliente','contacto'];
    const phoneH = ['telefono','numero','celular','whatsapp','phone','móvil'];
    let nameIdx = headers.findIndex(h => nameH.includes(h));
    if(nameIdx === -1) nameIdx = headers.findIndex(h => h.includes('nombre')) // Try partial
    if(nameIdx === -1) nameIdx = 1; // Default B

    let numIdxs = headers.map((h,i) => phoneH.some(ph=>h.startsWith(ph)) ? i : -1).filter(i => i !== -1);
    if(numIdxs.length === 0) numIdxs = [3,4,5]; // Default D,E,F

    const contacts = rows.reduce((acc, row, i) => {
      if (!row || row.every(c => c==null || String(c).trim()==='')) return acc;
      const fullName = String(row[nameIdx]||'').trim();
      const name = fullName.split(' ')[0] || `Fila_${i+2}`;
      const nums = new Set();
      numIdxs.forEach(idx => {
        const rawNum = String(row[idx]||'').trim().replace(/[^0-9+]/g, '');
        if (/^(\+?51)?9\d{8}$/.test(rawNum)) {
          let normNum = rawNum.startsWith('+51') ? rawNum : `+51${rawNum.replace(/^51/,'')}`;
          if (normNum.match(/^\+519\d{8}$/)) nums.add(normNum);
        }
      });
      if (nums.size > 0) acc.push({ name, numbers: [...nums], rowIndex: i+2 });
      return acc;
    }, []);
    res.json({ success: true, data: {
      totalRowsInFile:data.length-1, processedRows:rows.length, validContacts:contacts.length, contacts,
      summary:{totalContactsFound:contacts.length, totalNumbersFound:contacts.reduce((s,c)=>s+c.numbers.length,0)}
    }});
  } catch (e) {
    logger.error('Upload Excel Error:', e);
    if(req.file?.path) try{await fs.unlink(req.file.path)}catch{/*ignore*/}
    res.status(500).json({error:`Excel processing failed: ${e.message}`});
  }
});

app.post('/api/bulk-send', async (req, res) => {
  try {
    const {error,value}=messageSchema.validate(req.body);
    if(error) return res.status(400).json({error:error.details.map(d=>d.message).join(', ')});
    if(!global.providerInstance?.vendor?.user) return res.status(400).json({error:'WA not connected.'});
    if(!value.contacts?.length) return res.status(400).json({error:'No contacts.'});
    const id=`bulk_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
    const pData=bulkManager.createProcess(id,value);
    const started=await bulkManager.startProcess(id);
    if(started) res.status(202).json({success:true,processId:id,status:pData.status,message:pData.scheduledTime?`Scheduled ${id} for ${new Date(pData.scheduledTime).toLocaleString()}`:`Started ${id}`});
    else {bulkManager.deleteProcess(id);res.status(409).json({error:'Failed to start/schedule.'});}
  } catch(e){logger.error('Bulk Send API Error:',e);res.status(500).json({error:'Server error.'});}
});

app.post('/api/process/:id/:action', async (req,res)=>{
  const {id,action}=req.params; const p=bulkManager.getProcess(id);
  if(!p)return res.status(404).json({error:`PID ${id} not found.`});
  try{let ok=false,msg=''; switch(action){
    case 'pause':ok=await bulkManager.pauseProcess(id);msg=`PID ${id} ${ok?'paused':'fail pause'}.`;break;
    case 'resume':ok=await bulkManager.resumeProcess(id);msg=`PID ${id} ${ok?'resumed':'fail resume'}.`;break;
    case 'stop':ok=await bulkManager.stopProcess(id);msg=`PID ${id} ${ok?'stopped':'fail stop'}.`;break;
    default:return res.status(400).json({error:`Invalid action ${action}`});
  }res.json({success:ok,message:msg,processStatus:bulkManager.getProcess(id)?.status});
  }catch(e){logger.error(`PID ${id} action ${action} error:`,e);res.status(500).json({error:`Server error on ${action} for ${id}.`});}
});

app.get('/api/process/:id',(req,res)=>{
  const p=bulkManager.getProcess(req.params.id);
  if(!p)return res.status(404).json({error:'PID not found'});
  const {contacts,...summary}=p; res.json({success:true,data:{...summary,errors:p.errors.slice(-10)}});
});

app.get('/api/processes',(req,res)=>res.json({success:true,data:{list:bulkManager.getAllProcesses(),stats:bulkManager.getProcessStats()}}));

app.get('/api/qr',async(req,res)=>{
  try{
    if(global.providerInstance?.vendor?.user)return res.json({success:true,authenticated:true,message:"Authenticated."});
    if(IS_USING_PAIRING_CODE&&global.providerInstance?.pairingCode)return res.json({success:true,authenticated:false,qr:null,pairingCode:global.providerInstance.pairingCode,message:"Using pairing code."});
    const qrPath=path.join(__dirname,'bot.qr.png');
    try{res.json({success:true,authenticated:false,qr:`data:image/png;base64,${(await fs.readFile(qrPath)).toString('base64')}`});}
    catch(e){res.json({success:true,authenticated:false,qr:null,pairingCodeExpected:IS_USING_PAIRING_CODE,message:"Auth info not ready."});}
  }catch(e){logger.error('QR API Error:',e);res.status(500).json({error:'Server error QR.'});}
});

app.get('/api/status',(req,res)=>{
  const up=process.uptime(),mem=process.memoryUsage();
  res.json({success:true,data:{
    wa:{conn:!!global.providerInstance?.vendor?.user,user:global.providerInstance?.vendor?.user?{id:global.providerInstance.vendor.user.id,name:global.providerInstance.vendor.user.name}:null,stat:global.providerInstance?.getStatus?.()||'N/A'},
    srv:{up:`${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s`,mem:{rss:`${(mem.rss/1e6).toFixed(2)}MB`,heapU:`${(mem.heapUsed/1e6).toFixed(2)}MB`},nodeV:process.version,tz:TIMEZONE,port:PORT},
    procSum:bulkManager.getProcessStats()
  }});
});

wss.on('connection',wsClient=>{logger.info('WS client connected.');
  const send=(d)=>wsClient.readyState===1&&wsClient.send(JSON.stringify(d));
  send({type:'status_update',data:{connected:!!global.providerInstance?.vendor?.user,user:global.providerInstance?.vendor?.user||null}});
  if(!global.providerInstance?.vendor?.user&&global.providerInstance?.pairingCode)send({type:'pairing_code',data:global.providerInstance.pairingCode});
  wsClient.on('message',async msg=>{try{const d=JSON.parse(msg.toString());
    switch(d.type){
      case 'get_status':send({type:'status_update',data:{connected:!!global.providerInstance?.vendor?.user,user:global.providerInstance?.vendor?.user||null}});
        if(!global.providerInstance?.vendor?.user&&global.providerInstance?.pairingCode)send({type:'pairing_code',data:global.providerInstance.pairingCode});break;
      case 'request_qr':
        if(IS_USING_PAIRING_CODE&&global.providerInstance?.pairingCode)send({type:'pairing_code',data:global.providerInstance.pairingCode,message:"Pairing code mode."});
        else{try{send({type:'qr_update',data:`data:image/png;base64,${(await fs.readFile(path.join(__dirname,'bot.qr.png'))).toString('base64')}`});}
        catch{send({type:'qr_update',data:null,message:"QR not available."});}}break;
    }}catch(e){logger.error('WS msg err:',e);send({type:'error',message:'Invalid msg.'});}});
  wsClient.on('close',(c,r)=>logger.info(`WS client closed. ${c} ${r?.toString().substr(0,100)||''}`));
  wsClient.on('error',e=>logger.error('WS client err:',e));
});

app.use((e,q,s,n)=>{logger.error('Express Err:',{msg:e.message,stk:e.stack?.substr(0,500),url:q.originalUrl});
  if(e instanceof multer.MulterError)return s.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({error:`Upload err: ${e.message}`});
  if(e.isJoi)return s.status(400).json({error:'Validation err',details:e.details.map(d=>d.message)});
  s.status(e.status||500).json({error:process.env.NODE_ENV==='development'?e.message:'Server Error'});
});
app.use((q,s)=>s.status(404).json({error:'Not Found',message:`Route ${q.originalUrl} not found.`}));

Object.keys(signals={SIGINT:2,SIGTERM:15}).forEach(sig=>process.on(sig,async()=>{logger.info(`Got ${sig}, shutting down...`);
  bulkManager.processes.forEach((p,id)=>{if(['running','paused','scheduled','pending'].includes(p.status)){
    if(p.timeout)clearTimeout(p.timeout);bulkManager.updateProcess(id,{status:'stopped',completedAt:new Date()});logger.info(`PID ${id} stopped.`);}});
  wss.close(()=>logger.info('WS closed.'));server.close(async()=>{logger.info('HTTP closed.');
    if(global.providerInstance?.vendor)try{await global.providerInstance.vendor.end();logger.info('Baileys closed.');}catch(e){logger.error('Baileys close err:',e);}
    logger.info('Shutdown done.');process.exit(signals[sig]);});
  setTimeout(()=>process.exit(1),10000);}));

main().then(()=>{server.listen(PORT,()=>{logger.info(`🚀 Express http://localhost:${PORT}`);logger.info(`📱 WA Bulk Sender Ready.`);logger.info(`📊 WS ws://localhost:${PORT}`);
  const authM=IS_USING_PAIRING_CODE?(EXPECTED_PHONE_NUMBER?`Pairing Code for ${EXPECTED_PHONE_NUMBER}`:'Pairing Code (check console/UI)'):'QR Scan (bot.qr.png)';
  logger.info(`🔑 Auth: ${authM}`);});
}).catch(e=>{logger.error('❌ Server start failed:',e);process.exit(1);});