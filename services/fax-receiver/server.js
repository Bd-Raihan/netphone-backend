const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = 8099;
const INBOX_DIR = '/root/netphone-faxes/inbox';
const LOG_DIR = '/root/netphone-faxes/logs';

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'netphone-fax-receiver'
  });
});

app.post('/api/fax/webhook', async (req, res) => {
  const receivedAt = new Date().toISOString();

  try {
    const event = req.body || {};

    const eventType =
      event?.data?.event_type ||
      event?.event_type ||
      'unknown';

    const payload =
      event?.data?.payload ||
      event?.payload ||
      {};

    const faxId =
      payload?.fax_id ||
      payload?.id ||
      event?.data?.id ||
      Date.now();

    const logFile = path.join(
      LOG_DIR,
      `${Date.now()}_${safeName(eventType)}_${safeName(faxId)}.json`
    );

    fs.writeFileSync(
      logFile,
      JSON.stringify(
        {
          received_at: receivedAt,
          event
        },
        null,
        2
      )
    );

    console.log(`[FAX] event=${eventType} faxId=${faxId}`);

    if (eventType === 'fax.received') {
      const mediaUrl =
        payload?.media_url ||
        payload?.media?.url ||
        payload?.document_url;

      if (mediaUrl) {
        const pdfFile = path.join(
          INBOX_DIR,
          `fax_${safeName(faxId)}_${Date.now()}.pdf`
        );

        const response = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 60000
        });

        fs.writeFileSync(pdfFile, response.data);

        console.log(`[FAX] PDF saved: ${pdfFile}`);
      } else {
        console.log('[FAX] fax.received event found, but no media URL was present.');
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[FAX ERROR]', error.message);

    const errorFile = path.join(
      LOG_DIR,
      `error_${Date.now()}.log`
    );

    fs.writeFileSync(
      errorFile,
      `${new Date().toISOString()}\n${error.stack || error.message}\n`
    );

    res.status(200).json({
      received: true,
      processing_error: true
    });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`NetPhone Fax Receiver running on 127.0.0.1:${PORT}`);
});
