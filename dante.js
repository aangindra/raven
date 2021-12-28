require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { body: bodyValidator, validationResult } = require("express-validator");
const { verifyToken, authenticate } = require("./auth/verifyToken");

const dayjs = require("dayjs");
const fs = require("fs");
const uuidV4 = require("uuid/v4");
const { Client } = require('whatsapp-web.js');
const shell = require("shelljs");
const mongodbConnection = require("./mongodb_connection");
const Pusher = require("pusher");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");
const SENDER_LOAD_BALANCE = process.env.SENDER_LOAD_BALANCE
  ? process.env.SENDER_LOAD_BALANCE
  : "";

const SESSION_FILE_PATH = './sessions/session.json';
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionCfg = require(SESSION_FILE_PATH);
}

const start = async () => {
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

  app.get("/", async (req, res) => {
    return res.status(200).json({ message: "Welcome to API Raven 1.0.0" });
  });

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

            shell.exec(`pm2 reload wa-${session}`);

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

  app.get("/me", verifyToken, async (req, res) => {
    const activeSession = await authenticate(req);
    const Account = await collection("Accounts").findOne(
      {
        _id: activeSession._id,
      },
      {
        projection: {
          password: 0,
        },
      }
    );
    return res
      .status(200)
      .json({ message: "success me!", attributes: Account });
  });

  app.post(
    "/send_message",
    // verifyToken,
    [
      bodyValidator("sender").notEmpty().withMessage("sender cannot be empty!"),
      bodyValidator("phone").notEmpty().withMessage("phone cannot be empty!"),
      bodyValidator("message")
        .notEmpty()
        .withMessage("message cannot be empty!"),
      bodyValidator("type").notEmpty().withMessage("type cannot be empty!"),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { phone, message, type, image, file, sender, PREFIX } = req.body;
      const activeSession = await authenticate(req);
      if (!activeSession) {
        return res.status(403).json({ message: "Token invalid!" });
      }
      const foundAccount = await collection("Accounts").findOne({
        _id: activeSession._id,
      });
      if(!foundAccount) {
        return res.status(400).json({ message: "Token Invalid!" });
      }
      const listDevices = await collection("Devices")
        .find({
          $or: [{
            accountIds: {
              $in: [foundAccount._id],
            },
          }, {
            accountId: foundAccount.username
          }
          ],
        })
        .toArray();

      const devices = listDevices.map((device) => device.phone);
      if (!devices.includes(sender)) {
        if (sender !== "6283143574597") {
          return res.status(404).json({ message: "Sender not found!" });
        }
      }
      if (!["TEXT", "IMAGE", "FILE"].includes(type)) {
        return res
          .status(400)
          .json({ errors: { message: "Wrong type message!" } });
      }

      console.log(sender);

      let newMessage = {
        _id: uuidV4(),
        sender: sender === "6283143574597" ? "6285157574640" : sender,
        phone: "",
        message,
        type,
        isScheduled: false,
        PREFIX,
        _createdAt: dayjs().toISOString(),
        _updatedAt: dayjs().toISOString(),
      };
      if (type === "IMAGE" && image) {
        newMessage.image = image;
      } else if (type === "FILE" && file) {
        newMessage.file = file;
      } else {
        newMessage.type = "TEXT";
      }

      const phones = phone.split(",");
      for (let number of phones) {
        newMessage.phone = number.replace(/[^0-9.]/g, "");
        newMessage = generatedLoadBalanceMessage(newMessage);
        await collection("Messages").insertOne(newMessage);
      }
      let results = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", results);
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `POST /send_message => sender ${newMessage.sender}`
      );
      return res.status(200).json({ message: "Success send message!" });
    }
  );

  const PORT = process.env.API_PORT || 3000;
  const serverAfterListening = app.listen(PORT, () => {
    console.log(`WhatsApp API server running on port ${PORT}.`);
  });
  serverAfterListening.setTimeout(600000);
};

const generatedLoadBalanceMessage = (message) => {
  const loadBalancedSender = SENDER_LOAD_BALANCE.split(",");
  const phone = parseInt(message.phone);
  let result = message;

  if (
    loadBalancedSender.length > 1 &&
    !["6283179715536", "628973787777"].includes(result.sender)
    && loadBalancedSender.includes(result.sender)
  ) {
    if (phone % 2 === 0) {
      result.sender = loadBalancedSender[0];
      console.log("hit even!");
    } else {
      result.sender = loadBalancedSender[1];
      console.log("hit odd!");
    }
  }
  return result;
};

start();