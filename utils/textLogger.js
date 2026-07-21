const fs = require("fs/promises");
const path = require("path");

const LOG_DIRECTORY = path.join(
  __dirname,
  "../logs"
);

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024;

let writeQueue = Promise.resolve();

function safeLogName(value) {
  return String(value || "application")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

async function rotateLogIfNeeded(logFilePath) {
  try {
    const stats = await fs.stat(logFilePath);

    if (stats.size < MAX_LOG_SIZE_BYTES) {
      return;
    }

    const backupPath = `${logFilePath}.1`;

    await fs.rm(backupPath, {
      force: true,
    });

    await fs.rename(
      logFilePath,
      backupPath
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function appendTextLog(channel, entry) {
  const safeChannel = safeLogName(channel);

  const logFilePath = path.join(
    LOG_DIRECTORY,
    `${safeChannel}.log`
  );

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(LOG_DIRECTORY, {
        recursive: true,
      });

      await rotateLogIfNeeded(logFilePath);

      const logEntry = {
        timestamp: new Date().toISOString(),
        ...entry,
      };

      await fs.appendFile(
        logFilePath,
        `${JSON.stringify(logEntry)}\n`,
        "utf8"
      );
    })
    .catch((error) => {
      console.error(
        "Text log write failed:",
        error
      );
    });

  return writeQueue;
}

module.exports = {
  appendTextLog,
};