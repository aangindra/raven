require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { body: bodyValidator, validationResult } = require("express-validator");
const { verifyToken, authenticate } = require("./auth/verifyToken");

const dayjs = require("dayjs");
const fs = require("fs");
const fetchBase64 = require("fetch-base64");
const uuidV4 = require("uuid/v4");
const { Client, Location, List, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";
const mongodbConnection = require("./mongodb_connection");
const Pusher = require("pusher");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");
const browserArgs = [
  '--disable-web-security', '--no-sandbox', '--disable-web-security',
  '--aggressive-cache-discard', '--disable-cache', '--disable-application-cache',
  '--disable-offline-load-stale-cache', '--disk-cache-size=0',
  '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
  '--disable-sync', '--disable-translate', '--hide-scrollbars', '--metrics-recording-only',
  '--mute-audio', '--no-first-run', '--safebrowsing-disable-auto-update',
  '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list'
];

const SESSION_FILE_PATH = './sessions/session.json';
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionCfg = require(SESSION_FILE_PATH);
}

const start = async () => {
  console.log(dayjs().startOf("day").toISOString())
  console.log(dayjs().endOf("day").toISOString())

  throw new Error("...")
  if (!fs.existsSync(`./saved_sessions`)) {
    fs.mkdirSync(`./saved_sessions`, { recursive: true });
  }
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  const collection = await mongodbConnection("WA");
  let app = express();
  const corsOptions = {
    optionsSuccessStatus: 200,
  };
  // PreFLIGHT!
  app.options("*", cors(corsOptions));
  app.get("*", cors(corsOptions));
  app.post("*", cors(corsOptions));
  const rawBodySaver = (req, res, buf, encoding) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || "utf8");
    }
  };
  app.use(bodyParser.json({ verify: rawBodySaver }));
  app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: true }));
  app.use(
    bodyParser.raw({
      verify: rawBodySaver,
      type: () => true,
    })
  );

  app.post(
    "/login_whatsapp",
    verifyToken,
    [
      bodyValidator("session")
        .notEmpty()
        .withMessage("session cannot be empty!"),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      console.log(dayjs().format("YYYY-MM-DD HH:mm:ss"), " ", "POST /login");
      const { session } = req.body;
      // declare whatsapp-web-js instance
      const client = new Client({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], session: sessionCfg });
      client.initialize();
      try {
        const result = await new Promise((resolve, reject) => {
          client.on("qr", (qr) => {
            // NOTE: This event will not be fired if a session is specified.
            // console.log('QR RECEIVED', qr);
            // qrcode.generate(qr, { small: true });
            resolve(qr);
          });
          client.on("ready", () => {
            resolve("isLogged");
          });
          client.on("authenticated", async (token) => {
            fs.writeFileSync(`${__dirname + '/saved_sessions/' + session}.data.json`, JSON.stringify(token));
            await collection("Devices").updateOne(
              {
                phone: session,
              },
              {
                $set: {
                  status: "CONNECTED",
                },
              }
            );
            resolve("isAuthenticated")
          })
        });

        // if (result === "isLogged" || result === "isAuthenticated") {
        //   return res
        //     .status(200)
        //     .json({ message: "Success login!", status: client, qrCode: "" });
        // }

        return res.status(200).json({
          message: "QR Code generated!",
          status: "notLogged",
          qrCode: result,
        });
      } catch (e) {
        console.warn(e)
      }

    }
  );

  app.post(
    "/disconnect",
    verifyToken,
    [
      bodyValidator("session")
        .notEmpty()
        .withMessage("session cannot be empty!"),
    ],
    async (req, res) => {
      const { session } = req.body;
      let pathTokens = __dirname + `/saved_sessions/${session}.data.json`;
      try {
        if (fs.existsSync(pathTokens)) {
          fs.unlinkSync(pathTokens);
        }
        await collection("Devices").updateOne(
          {
            phone: session,
          },
          {
            $set: {
              status: "DISCONNECTED",
            },
          }
        );
      } catch (e) {
        console.log(e);
      }
      return res.status(200).json({ message: "Disconnect successfully!", status: "notLogged" });
    }
  );

  const PORT = process.env.API_PORT || 3000;
  const serverAfterListening = app.listen(PORT, () => {
    console.log(`WhatsApp API server running on port ${PORT}.`);
  });
  serverAfterListening.setTimeout(600000);
};

start();