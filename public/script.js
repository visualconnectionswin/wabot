// public/script.js
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // UI Elements
    const btnConnect = document.getElementById('btnConnect');
    const qrArea = document.getElementById('qrArea');
    const qrMessage = document.getElementById('qrMessage');
    const qrImage = document.getElementById('qrImage');
    const btnLogout = document.getElementById('btnLogout');

    const sectionUpload = document.getElementById('section-upload');
    const contactsFile = document.getElementById('contactsFile');
    const btnUploadFile = document.getElementById('btnUploadFile');
    const fileStatus = document.getElementById('fileStatus');
    const contactsPreview = document.getElementById('contactsPreview');

    const sectionMessage = document.getElementById('section-message');
    const messageTemplate = document.getElementById('messageTemplate');
    const sendInterval = document.getElementById('sendInterval');
    const btnStartSending = document.getElementById('btnStartSending');
    const btnPauseSending = document.getElementById('btnPauseSending');
    const btnResumeSending = document.getElementById('btnResumeSending');
    const btnStopSending = document.getElementById('btnStopSending');

    const sectionProgress = document.getElementById('section-progress');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const statusText = document.getElementById('statusText'); // Global status text
    const lastSentInfo = document.getElementById('lastSentInfo'); // Info about last sent


    let currentBotState = 'pending';
    let totalContactsInCurrentFile = 0;

    function updateUIForState(data) {
        currentBotState = data.state;
        statusText.textContent = `Estado general: ${currentBotState}`;
        
        // Reset visibilidad y activación por defecto
        btnLogout.style.display = 'none';
        sectionUpload.style.display = 'none';
        sectionMessage.style.display = 'none';
        sectionProgress.style.display = 'none';
        
        btnStartSending.disabled = true;
        btnPauseSending.disabled = true;
        btnResumeSending.disabled = true;
        btnStopSending.disabled = true;
        btnConnect.disabled = false;

        qrImage.style.display = 'none';
        qrMessage.textContent = 'Esperando conexión...';

        switch (currentBotState) {
            case 'pending':
            case 'initializing':
                qrMessage.textContent = 'Inicializando bot, por favor espera...';
                break;
            case 'qr':
                qrMessage.textContent = 'Escanea el código QR con WhatsApp:';
                if (data.qr) {
                    qrImage.src = data.qr;
                    qrImage.style.display = 'block';
                }
                btnConnect.disabled = true;
                break;
            case 'ready':
                qrMessage.textContent = '¡Conectado a WhatsApp!';
                btnLogout.style.display = 'inline-block';
                sectionUpload.style.display = 'block';
                btnConnect.disabled = true;
                if (totalContactsInCurrentFile > 0) { // Si ya hay un archivo procesado
                    sectionMessage.style.display = 'block';
                    sectionProgress.style.display = 'block';
                    btnStartSending.disabled = false;
                }
                break;
            case 'disconnected':
                qrMessage.textContent = `Desconectado. ${data.error || 'Intenta reconectar.'}`;
                break;
            case 'error':
                qrMessage.textContent = `Error: ${data.error || 'Error desconocido. Revisa la consola del servidor.'}`;
                statusText.textContent = `Estado: Error - ${data.error || 'Revisa consola'}`;
                break;
            case 'file_processed': // Estado intermedio después de cargar archivo
                qrMessage.textContent = '¡Conectado a WhatsApp!'; // Asumiendo que sigue conectado
                btnLogout.style.display = 'inline-block';
                sectionUpload.style.display = 'block'; 
                sectionMessage.style.display = 'block';
                sectionProgress.style.display = 'block';
                btnStartSending.disabled = false;
                statusText.textContent = `Estado: Archivo procesado. ${data.total || totalContactsInCurrentFile} contactos listos.`;
                if (data.total) totalContactsInCurrentFile = data.total;
                progressBar.style.width = '0%'; // Resetear progreso para nueva campaña
                progressText.textContent = `0% (0/${totalContactsInCurrentFile})`;
                lastSentInfo.textContent = '';
                break;
            case 'sending':
                qrMessage.textContent = '¡Conectado a WhatsApp!';
                btnLogout.style.display = 'inline-block';
                sectionUpload.style.display = 'none'; // Ocultar subida durante envío
                sectionMessage.style.display = 'block';
                sectionProgress.style.display = 'block';
                btnStartSending.disabled = true;
                btnPauseSending.disabled = false;
                btnStopSending.disabled = false;
                break;
            case 'paused':
                qrMessage.textContent = '¡Conectado a WhatsApp!';
                btnLogout.style.display = 'inline-block';
                sectionUpload.style.display = 'none';
                sectionMessage.style.display = 'block';
                sectionProgress.style.display = 'block';
                btnPauseSending.disabled = true;
                btnResumeSending.disabled = false;
                btnStopSending.disabled = false;
                break;
            case 'stopped':
            case 'finished':
                qrMessage.textContent = '¡Conectado a WhatsApp!';
                btnLogout.style.display = 'inline-block';
                sectionUpload.style.display = 'block'; // Permitir nueva subida
                sectionMessage.style.display = 'block';
                sectionProgress.style.display = 'block';
                btnStartSending.disabled = false; // Permitir iniciar nueva campaña
                statusText.textContent = currentBotState === 'finished' ? 'Estado: ¡Todos los mensajes enviados!' : 'Estado: Envíos detenidos por el usuario.';
                if (currentBotState === 'finished' && totalContactsInCurrentFile > 0) {
                     progressBar.style.width = '100%';
                     progressText.textContent = `100% (${data.sent || totalContactsInCurrentFile}/${data.total || totalContactsInCurrentFile})`;
                }
                break;
        }
        
        // Actualizar barra de progreso y contadores
        if (data.total !== undefined && data.sent !== undefined) {
            const total = data.total || totalContactsInCurrentFile;
            if (total > 0) {
                const progressPercentage = (data.sent / total) * 100;
                progressBar.style.width = `${Math.min(100, progressPercentage)}%`; // Asegurar no pasar 100%
                progressText.textContent = `${Math.round(progressPercentage)}% (${data.sent}/${total})`;
            } else if (currentBotState !== 'file_processed' && currentBotState !== 'ready') {
                 progressBar.style.width = '0%';
                 progressText.textContent = `0% (0/0)`;
            }
        }
        
        if (data.lastSent) {
            lastSentInfo.innerHTML = `Último intento: ${data.lastSent.name} - ${data.lastSent.success ? 'OK' : `<span style="color:red;">Fallo (${data.lastSent.error || ''})</span>`}`;
        } else if (data.error && currentBotState !== 'error') { // Errores no fatales durante el envío
             lastSentInfo.innerHTML = `<span style="color:red;">Error: ${data.error}</span>`;
        }
    }

    socket.on('statusUpdate', (data) => {
        console.log('Status Update Received:', data);
        if (data.state === 'file_processed' && data.total !== undefined) {
            totalContactsInCurrentFile = data.total;
        }
        updateUIForState(data);
    });

    btnConnect.addEventListener('click', async () => {
        qrMessage.textContent = 'Solicitando conexión/QR...';
        qrImage.style.display = 'none';
        btnConnect.disabled = true;
        try {
            const response = await fetch('/api/init-bot');
            const data = await response.json();
            // La UI se actualizará principalmente vía Socket.IO tras esta llamada.
            // Esta respuesta es solo una confirmación inicial.
            qrMessage.textContent = data.message || 'Petición enviada. Espera actualizaciones.';
            if (!data.success) btnConnect.disabled = false; // Re-enable if initial call failed
        } catch (error) {
            qrMessage.textContent = 'Error de conexión con el servidor al intentar conectar.';
            console.error('Error fetching QR/init status:', error);
            btnConnect.disabled = false;
        }
    });
    
    btnLogout.addEventListener('click', async () => {
        if (!confirm("¿Estás seguro de que deseas cerrar la sesión de WhatsApp? Esto detendrá cualquier envío en curso.")) return;
        qrMessage.textContent = 'Cerrando sesión...';
        try {
            await fetch('/api/logout', { method: 'POST' });
            totalContactsInCurrentFile = 0; // Resetear contador
            contactsPreview.innerHTML = ''; // Limpiar preview
            fileStatus.textContent = '';
            // La UI se actualizará vía Socket.IO al estado 'pending' o similar.
        } catch (error) {
            alert('Error al cerrar sesión: ' + error.message);
        }
    });

    btnUploadFile.addEventListener('click', async () => {
        const file = contactsFile.files[0];
        if (!file) {
            fileStatus.textContent = 'Por favor, selecciona un archivo XLSX.';
            return;
        }

        const formData = new FormData();
        formData.append('contactsFile', file);
        fileStatus.textContent = 'Subiendo y procesando archivo...';
        btnUploadFile.disabled = true;

        try {
            const response = await fetch('/api/upload-xlsx', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            fileStatus.textContent = data.message || (data.success ? 'Archivo procesado.' : 'Error.');
            if (data.success && data.totalContacts !== undefined) {
                totalContactsInCurrentFile = data.totalContacts;
                 // La actualización completa de la UI (mostrar sección de mensaje, etc.) vendrá por socket 'file_processed'
                if(data.preview && data.preview.length > 0){
                    contactsPreview.innerHTML = '<strong>Primeros contactos (preview):</strong><ul>' +
                        data.preview.map(c => `<li>${c.name} - ${c.number}</li>`).join('') + '</ul>';
                } else {
                    contactsPreview.innerHTML = 'No se encontraron contactos válidos en el archivo o no hay preview.';
                }
            } else {
                contactsPreview.innerHTML = '';
            }
        } catch (error) {
            fileStatus.textContent = 'Error de red al subir el archivo.';
            console.error('Error uploading file:', error);
            contactsPreview.innerHTML = '';
        } finally {
            btnUploadFile.disabled = false;
        }
    });

    btnStartSending.addEventListener('click', async () => {
        const message = messageTemplate.value.trim();
        const intervalSeconds = parseInt(sendInterval.value, 10);

        if (!message) {
            alert('Por favor, escribe un mensaje.'); return;
        }
        if (isNaN(intervalSeconds) || intervalSeconds < 1) {
            alert('Intervalo inválido (mínimo 1 segundo).'); return;
        }
        if (totalContactsInCurrentFile === 0 && currentBotState !== 'paused') { // Permitir reanudar si está pausado aunque el contador sea 0 momentáneamente
            alert('No hay contactos cargados o el archivo no se procesó bien.'); return;
        }
        if (currentBotState !== 'ready' && currentBotState !== 'file_processed' && currentBotState !== 'stopped' && currentBotState !== 'finished') {
             alert(`El bot no está en un estado para iniciar envíos (actual: ${currentBotState}).`); return;
        }
        lastSentInfo.textContent = ''; // Limpiar info de envío anterior
        try {
            await fetch('/api/start-sending', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, interval: intervalSeconds * 1000 })
            });
            // UI se actualiza por socket
        } catch (error) {
            alert('Error de red al iniciar envíos: ' + error.message);
        }
    });

    btnPauseSending.addEventListener('click', async () => {
        try { await fetch('/api/pause-sending', { method: 'POST' }); } 
        catch (error) { alert('Error al pausar: ' + error.message); }
    });

    btnResumeSending.addEventListener('click', async () => {
        try { await fetch('/api/resume-sending', { method: 'POST' }); }
        catch (error) { alert('Error al reanudar: ' + error.message); }
    });

    btnStopSending.addEventListener('click', async () => {
        if (!confirm("¿Detener todos los envíos? El progreso actual se conservará hasta que inicies una nueva campaña.")) return;
        try { await fetch('/api/stop-sending', { method: 'POST' }); }
        catch (error) { alert('Error al detener: ' + error.message); }
    });
});