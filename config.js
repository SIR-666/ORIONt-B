const dotenv = require("dotenv");

dotenv.config();

const config = {
  user: "admin_prf",
  password: "!23QWE45d",
  server: "10.24.0.98",
  database: "dbOR_new",
  pool: {
    max: 10, // Maximum number of connections in the pool
    min: 0, // Minimum number of connections in the pool
    idleTimeoutMillis: 30000, // Time a connection should stay idle before being released
  },
  options: {
    encrypt: true, // Use this if you're on Azure SQL or need encryption
    trustServerCertificate: true, // Change to false for production environments
  },
};

module.exports = config;
