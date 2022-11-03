require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { body: bodyValidator, validationResult } = require("express-validator");
const { verifyToken, authenticate } = require("./auth/verifyToken");

const dayjs = require("dayjs");
const fs = require("fs");
const uuidV4 = require("uuid/v4");
const { Client, LocalAuth } = require("whatsapp-web.js");
const shell = require("shelljs");
const { get, sample, keyBy } = require("lodash");
const mongodbConnection = require("./mongodb_connection");
const { initRedis } = require("./redisCache");
const Pusher = require("pusher");
const socketIo = require("socket.io");
const http = require("http");
const {
  createSession,
  formatPhone,
  getSession,
  deleteSession,
  sendMessage,
  isExists,
  buildSession,
} = require("./baileys");
const utils = require("./libs/utils");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET, VERSION_APP } =
  process.env;
const { calculateMessage } = require("./calculate_message");
const path = require("path");
const SENDER_LOAD_BALANCE = process.env.SENDER_LOAD_BALANCE
  ? process.env.SENDER_LOAD_BALANCE
  : "";
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";

const SESSION_FILE_PATH = "./sessions/session.json";
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionCfg = require(SESSION_FILE_PATH);
}

const browserArgs = [
  "--disable-web-security",
  "--no-sandbox",
  "--disable-web-security",
  "--disable-gpu",
  "--aggressive-cache-discard",
  "--disable-cache",
  "--disable-application-cache",
  "--disable-offline-load-stale-cache",
  "--disk-cache-size=0",
  "--disable-software-rasterizer",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
  "--disable-dev-shm-usage",
  "--ignore-certificate-errors",
  "--ignore-ssl-errors",
  "--ignore-certificate-errors-spki-list",
];

const LIST_NOTIFICATION_TYPE = {
  GENERAL: "GENERAL",
  OTP: "OTP",
  PPDB: "PPDB",
  EMPLOYEE_PRESENCE: "EMPLOYEE_PRESENCE",
  STUDENT_PRESENCE: "STUDENT_PRESENCE",
  STUDENT_BILL_PAYMENT: "FINANCE",
};

const LIST_PHONE = {
  phone1: "628175121712",
  phone2: "6282110732206",
  phone3: "6283143574597",
  phone4: "6283179715536",
};

const BLACKLIST_PHONE_NUMBER = {
  [LIST_PHONE.phone1]: "6285157574640",
  [LIST_PHONE.phone2]: "62859106505353",
  [LIST_PHONE.phone3]: "6285157574640",
  [LIST_PHONE.phone4]: "6281216568005",
};

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
  const { cache } = await initRedis();

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

  const serverSocketIO = http.createServer(app);

  const io = socketIo(serverSocketIO, {
    transports: ["polling"],
    cors: {
      cors: {
        origin: "http://localhost:6102",
      },
    },
  });

  io.on("connection", (socket) => {
    console.log(`A user is connected! ${socket.id}`);

    socket.on("message", (message) => {
      console.log(`message from ${socket.id} : ${message}`);
    });

    socket.on("disconnect", () => {
      console.log(`socket ${socket.id} disconnected`);
    });
  });

  app.get("/", async (req, res) => {
    return res
      .status(200)
      .json({ message: `Welcome to API Raven ${VERSION_APP || "1.0.0"}` });
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
      const client = new Client({
        headless: true,
        authTimeout: 0, // https://github.com/pedroslopez/whatsapp-web.js/issues/935#issuecomment-952867521
        qrTimeoutMs: 0,
        // args: ['--no-sandbox', '--disable-setuid-sandbox'],
        args: browserArgs,
        authStrategy: new LocalAuth(),
      });
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
            console.log(token);
            fs.writeFileSync(
              `${__dirname + "/saved_sessions/" + session}.data.json`,
              JSON.stringify(token)
            );
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

            resolve("isAuthenticated");
          });
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
        console.warn(e);
      }
    }
  );

  app.post(
    "/login_whatsapp_multiple",
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

      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        "POST /login_whatsapp_multiple"
      );
      const { session } = req.body;

      const worker = `saved_sessions/session-${session}`;
      if (!fs.existsSync(worker)) {
        fs.mkdirSync(worker, { recursive: true });
      } else {
        fs.rmdirSync(worker, { recursive: true });
        fs.mkdirSync(worker, { recursive: true });
      }

      try {
        await createSession({
          sessionId: session,
          isLegacy: false,
          collection,
          socket: io,
          cache,
        });

        return res.status(200).json({
          message: "QR Code generated!",
          status: "notLogged",
          qrCode: "-",
        });
      } catch (e) {
        console.warn(e);
      }
    }
  );

  app.post(
    "/send_message_baileys",
    [
      bodyValidator("session")
        .notEmpty()
        .withMessage("session cannot be empty!"),
    ],
    async (req, res) => {
      const { session, phone, messageType, payload } = req.body;
      const phoneFormat = utils.formatPhone(phone, "ID");
      const mobileNumber = utils.formatPhone(session);
      const foundSession = await getSession(mobileNumber, cache);
      const receiverPhone = formatPhone(phoneFormat);
      if (foundSession) {
        const exists = await isExists(foundSession, receiverPhone);

        if (!exists) {
          if (messageType === "SCHEDULED") {
            await collection("ScheduleMessages").updateOne(
              {
                _id: payload._id,
              },
              {
                $set: {
                  errorAt: new Date().toISOString(),
                  errorMessage: "Invalid phone number!",
                },
              }
            );
          } else {
            await collection("Messages").updateOne(
              {
                _id: payload._id,
              },
              {
                $set: {
                  errorAt: new Date().toISOString(),
                  errorMessage: "Invalid phone number!",
                },
              }
            );
          }

          console.log("Invalid phone number!");

          return res.status(404).json({
            status: false,
            message: "Number not valid!",
          });
        }
        if (payload.type === "FILE") {
          await sendMessage(foundSession, receiverPhone, {
            text: payload.message,
          });
          sendMessage(foundSession, receiverPhone, {
            document: { url: payload.file },
            mimetype: "application/pdf",
            fileName: uuidV4(),
          });
        } else if (payload.type === "IMAGE") {
          await sendMessage(foundSession, receiverPhone, {
            text: payload.message,
          });
          sendMessage(foundSession, receiverPhone, {
            image: { url: payload.image },
            fileName: uuidV4(),
          });
        } else {
          await sendMessage(foundSession, receiverPhone, {
            text: payload.message,
          });
        }
        let results = await calculateMessage(collection);
        pusher.trigger("whatsapp-gateway", "message", results);
      } else {
        console.log("Whatsapp not connected!");
        return res.status(200).json({
          status: false,
          message: `Whatsapp not connected!`,
        });
      }
      return res.status(200).json({
        status: true,
        message: `Successfully sent message to ${receiverPhone}`,
      });
    }
  );

  // app.post(
  //   "/login_whatsapp_multiple",
  //   verifyToken,
  //   [
  //     bodyValidator("session")
  //       .notEmpty()
  //       .withMessage("session cannot be empty!"),
  //   ],
  //   async (req, res) => {
  //     const errors = validationResult(req);
  //     if (!errors.isEmpty()) {
  //       return res.status(400).json({ errors: errors.array() });
  //     }

  //     console.log(dayjs().format("YYYY-MM-DD HH:mm:ss"), " ", "POST /login_whatsapp_multiple");
  //     const { session } = req.body;

  //     const worker = `saved_sessions/session-${session}`;
  //     if (!fs.existsSync(worker)) {
  //       fs.mkdirSync(worker, { recursive: true });
  //     } else {
  //       fs.rmdirSync(worker, { recursive: true });
  //       fs.mkdirSync(worker, { recursive: true });
  //     }
  //     // declare whatsapp-web-js instance
  //     const client = new Client({
  //       headless: true,
  //       authTimeout: 0, // https://github.com/pedroslopez/whatsapp-web.js/issues/935#issuecomment-952867521
  //       qrTimeoutMs: 0,
  //       // args: ['--no-sandbox', '--disable-setuid-sandbox'],
  //       args: browserArgs,
  //       executablePath: path.join(__dirname, "node_modules/puppeteer/.local-chromium/linux-970485/chrome-linux/chrome"),
  //       authStrategy: new LocalAuth({
  //         dataPath: path.join(__dirname, `saved_sessions/session-${session}`),
  //       }),
  //     });
  //     client.initialize();
  //     try {
  //       client.on("qr", (qr) => {
  //         io.emit("QR_CODE", JSON.stringify({ qrCode: qr }));
  //       });
  //       client.on("ready", () => {
  //         console.log("is logged multi-device");
  //       });
  //       client.on("authenticated", async (token) => {
  //         console.log("authenticated multi-device", token)
  //       });

  //       return res.status(200).json({
  //         message: "QR Code generated!",
  //         status: "notLogged",
  //         qrCode: "-",
  //       });
  //     } catch (e) {
  //       console.warn(e)
  //     }

  //   }
  // );

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
        await deleteSession({ session, collection });
      } catch (e) {
        console.log(e);
      }
      return res
        .status(200)
        .json({ message: "Disconnect successfully!", status: "notLogged" });
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
      const {
        phone,
        message,
        notificationType,
        type,
        image,
        file,
        sender,
        PREFIX,
      } = req.body;
      const activeSession = await authenticate(req);
      if (!activeSession) {
        return res.status(403).json({ message: "Token invalid!" });
      }
      const foundAccount = await collection("Accounts").findOne({
        _id: activeSession._id,
      });
      if (!foundAccount) {
        return res.status(400).json({ message: "Token Invalid!" });
      }
      const listDevices = await collection("Devices")
        .find({
          $or: [
            {
              accountIds: {
                $in: [foundAccount._id],
              },
            },
            {
              accountId: foundAccount.username,
            },
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

      let newMessage = {
        _id: uuidV4(),
        sender: get(BLACKLIST_PHONE_NUMBER, sender, sender),
        // sender: sender === "6283143574597" ? "6285157574640" : sender,
        phone: "",
        message,
        notificationType,
        type,
        isScheduled: false,
        PREFIX,
        _createdAt: dayjs().toISOString(),
        _updatedAt: dayjs().toISOString(),
      };

      newMessage.sender = utils.assignSenderByNotificationType({
        devices: listDevices,
        message: newMessage,
      });

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
        // newMessage = generatedLoadBalanceMessage({
        //   message: newMessage,
        //   devices: listDevices,
        // });
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
  serverSocketIO.listen(process.env.SOCKET_PORT || 1000, () => {
    buildSession({ socket: io, collection });
    console.log(
      `Started websocket server at http://0.0.0.0:${process.env.SOCKET_PORT}!`
    );
  });
};

const generatedLoadBalanceMessage = ({ message, devices }) => {
  const loadBalancedSender = SENDER_LOAD_BALANCE.split(",");
  let result = message;
  const senderNumberException = devices
    .filter((device) => !device.isLoadBalancer)
    .map((dev) => dev.phone);
  if (
    loadBalancedSender.length > 1 &&
    !senderNumberException.includes(result.sender)
  ) {
    result.sender = sample(loadBalancedSender);
  }
  return result;
};

const assignSenderByNotificationType = ({ devices, message }) => {
  const indexedSenderByPhone = keyBy(devices, "phone");
  const isBlacklisted = get(BLACKLIST_PHONE_NUMBER, message.sender);
  if (isBlacklisted) {
    message.sender = BLACKLIST_PHONE_NUMBER[message.sender];
  }

  if (
    indexedSenderByPhone[message.sender] &&
    !indexedSenderByPhone[message.sender].isLoadBalancer
  ) {
    console.log(
      "sender is not changing",
      message.sender,
      indexedSenderByPhone[message.sender].isLoadBalancer
    );
    return message.sender;
  }
  const indexedSenderByNotificationType = devices
    .filter((device) => device.isLoadBalancer)
    .reduce((acc, device) => {
      if (device.notificationType) {
        for (let type of device.notificationType) {
          if (!acc[type]) {
            acc[type] = [];
          }
          acc[type].push(device.phone);
        }
      }
      return acc;
    }, {});

  const notificationType = get(
    LIST_NOTIFICATION_TYPE,
    message.notificationType
  );
  console.log("message", message);
  console.log("notificationType", notificationType);
  console.log(
    "indexedSenderByNotificationType",
    indexedSenderByNotificationType[notificationType]
  );
  if (!notificationType || !indexedSenderByNotificationType[notificationType]) {
    console.log(
      "sender is not changing",
      message.sender,
      indexedSenderByPhone[message.sender].isLoadBalancer
    );
    return message.sender;
  }

  if (indexedSenderByNotificationType[notificationType].length === 0) {
    console.log(
      "sender is not changing",
      message.sender,
      indexedSenderByPhone[message.sender].isLoadBalancer,
      indexedSenderByNotificationType[notificationType].length
    );
    return message.sender;
  }

  return sample(indexedSenderByNotificationType[notificationType]);
};

start();
