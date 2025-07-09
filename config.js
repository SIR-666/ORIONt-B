const dotenv = require("dotenv");

dotenv.config();

const config = {
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  server: process.env.DATABASE_SERVER,
  database: process.env.DATABASE_NAME,
  requestTimeout: 60000, // ✅ Tambahkan ini — timeout dalam milidetik (misalnya: 60 detik)
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 60000,
  },
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

module.exports = config;
