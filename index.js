// index.js
const { startServer } = require('./server');

// Cualquier otra inicialización global podría ir aquí si fuera necesario.
// Por ejemplo, conexiones a bases de datos externas (no aplica para MemoryDB de builderbot).

console.log("Iniciando aplicación...");
startServer();