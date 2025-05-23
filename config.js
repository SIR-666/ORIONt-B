const dotenv = require("dotenv");

dotenv.config();

const config = {
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  server: process.env.DATABASE_SERVER,
  database: process.env.DATABASE_NAME,
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
