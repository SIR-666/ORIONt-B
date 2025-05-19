const { createLogger, format, transports } = require("winston");
const { combine, printf, colorize } = format;
const fs = require("fs");
const path = require("path");
const moment = require("moment");

// Create log directory if it doesn't exist yet
const logDir = "logs";
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Custom timestamp formatter for Asia/Jakarta in YYYY-MM-DD HH:mm:ss
const timestampWIB = () => {
  return moment()
    .utcOffset(7 * 60)
    .format("YYYY-MM-DD HH:mm:ss");
};

// Format log line
const logFormat = printf(({ level, message }) => {
  return `${timestampWIB()} [${level.toUpperCase()}]: ${message}`;
});

const logger = createLogger({
  level: "info",
  format: combine(logFormat),
  transports: [
    new transports.Console({
      format: combine(colorize(), logFormat),
    }),
    new transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
    }),
    new transports.File({
      filename: path.join(logDir, "warn.log"),
      level: "warn",
    }),
    new transports.File({
      filename: path.join(logDir, "combined.log"),
    }),
  ],
});

module.exports = logger;
