require("dotenv").config();
const fs = require("fs");
const venom = require("venom-bot");
const { existsSync, mkdirSync } = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const dayjs = require("dayjs");
const uuidV4 = require("uuid/v4");
const cors = require("cors");
const mongodbConnection = require("./mongodb_connection");
const { body: bodyValidator, validationResult } = require("express-validator");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const shell = require("shelljs");
const { verifyToken, authenticate } = require("./auth/verifyToken");
const Pusher = require("pusher");
const { calculateMessage } = require("./calculate_message");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const SECRET_KEY = process.env.SECRET_KEY ? process.env.SECRET_KEY : uuidV4();
const SENDER_LOAD_BALANCE = process.env.SENDER_LOAD_BALANCE
  ? process.env.SENDER_LOAD_BALANCE
  : "";

const start = async () => {
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
      try {
        const venomOptions = {
          multidevice: false,
          folderNameToken: "tokens",
          mkdirFolderToken: "",
          headless: true,
          devtools: false,
          useChrome: true,
          debug: false,
          logQR: false,
          browserArgs: ["--no-sandbox"],
          refreshQR: 15000,
          autoClose: false,
          disableSpins: true,
          disableWelcome: true,
          // createFileToken: true,
        };
        const client = await new Promise((resolve, reject) => {
          venom.create(
            session,
            (base64Qr, asciiQR) => {
              if (!existsSync(`./log_qr`)) {
                mkdirSync(`./log_qr`, { recursive: true });
              }
              exportQR(base64Qr, `log_qr/qrCode_${session}.png`);
              resolve(base64Qr);
            },
            async (statusSession) => {
              if (statusSession === "isLogged") {
                resolve(statusSession);
              } else if (statusSession === "qrReadSuccess") {
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
                resolve(statusSession);
              }
            },
            venomOptions,
            (browser, waPage) => {
              console.log('Browser PID:', browser.process().pid);
              waPage.screenshot({ path: 'screenshot.png' });
            }
          ).then(async callback => {
            const token = await callback.getSessionTokenBrowser();
            fs.writeFileSync(`${__dirname + '/saved_tokens/' + session}.data.json`, JSON.stringify(token));
          });
        });
        if (client === "isLogged") {
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
          return res
            .status(200)
            .json({ message: "Success login!", status: client, qrCode: "" });
        }
        return res.status(200).json({
          message: "Success login!",
          status: "notLogged",
          qrCode: client,
        });
      } catch (e) {
        console.log(e);
      }
    }
  );
  app.post(
    "/register",
    [
      bodyValidator("username")
        .notEmpty()
        .withMessage("username cannot be empty!"),
      bodyValidator("password")
        .notEmpty()
        .withMessage("password cannot be empty!"),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { username, password } = req.body;

      const hashedPassword = bcrypt.hashSync(password, 8);

      const foundUser = await collection("Accounts").findOne({
        username,
      });
      if (foundUser) {
        return res
          .status(400)
          .json({ success: false, message: "username has been taken!" });
      }
      const User = {
        _id: uuidV4(),
        username,
        password: hashedPassword,
        _createdAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      };
      await collection("Accounts").insertOne(User);
      const token = jwt.sign({ _id: User._id }, SECRET_KEY);
      await collection("UserTokens").insertOne({
        _id: uuidV4(),
        accountId: User._id,
        _token: token,
        _createdAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({
        message: "Success register!",
        attributes: {
          username: User.username,
          _token: token,
          _createdAt: User._createdAt,
        },
      });
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
  // app.get('/get-qr', verifyToken, async (req, res) => {
  // 	console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'), ' ', 'GET /get-qr');
  // 	const imageAsBase64 = base64Encode(__dirname + `/log_qr/qrCode_${req.query.session}.png`);
  // 	return res.send(imageAsBase64);
  // });
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
      let pathQrCode = __dirname + `/log_qr/qrCode_${session}.png`;
      let pathTokens = __dirname + `/tokens/${session}.data.json`;
      let pathFolderTokens = __dirname + `/tokens/${session}`;
      try {
        if (fs.existsSync(pathQrCode)) {
          fs.unlinkSync(pathQrCode);
        }
        if (fs.existsSync(pathTokens)) {
          fs.unlinkSync(pathTokens);
        }
        if (fs.existsSync(pathFolderTokens)) {
          fs.rmdirSync(pathFolderTokens, { recursive: true });
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
      return res.status(200).json({ message: "Disconnect success!" });
    }
  );
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
      var ip;
      if (req.headers['x-forwarded-for']) {
        ip = req.headers['x-forwarded-for'].split(",")[0];
      } else if (req.connection && req.connection.remoteAddress) {
        ip = req.connection.remoteAddress;
      } else {
        ip = req.ip;
      } 

      const { phone, message, type, image, file, sender, PREFIX } = req.body;
      const activeSession = await authenticate(req);
      if (!activeSession) {
        return res.status(403).json({ message: "Token invalid!" });
      }
      const foundAccount = await collection("Accounts").findOne({
        _id: activeSession._id,
      });
      const listDevices = await collection("Devices")
        .find({
          accountIds: {
            $in: [foundAccount._id],
          },
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
        sender: sender === "6283143574597" ? "6285157574640" : sender,
        phone: "",
        message,
        type,
        isScheduled: false,
        PREFIX,
        clientIp: ip,
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
  // app.post("/test-websocket", async (req, res) => {
  //   const findDeletes = await collection("Messages").find().limit(20).toArray();
  //   await collection("Messages").deleteMany({
  //     _id: {
  //       $in: findDeletes.map((msg) => msg._id),
  //     },
  //   });
  //   let results = await calculateMessage(collection);
  //   pusher.trigger("whatsapp-gateway", "message", results);
  //   return res.status(200).json({
  //     message: "Success test",
  //   });
  // });
  const PORT = process.env.API_PORT || 3000;
  const serverAfterListening = app.listen(PORT, () => {
    console.log(`WhatsApp API server running on port ${PORT}.`);
  });
  serverAfterListening.setTimeout(600000);
};

// Writes QR in specified path
const exportQR = (base64Qr, path) => {
  let matches = base64Qr.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
    response = {};

  if (matches.length !== 3) {
    return new Error("Invalid input string");
  }
  response.type = matches[1];
  response.data = new Buffer.from(matches[2], "base64");

  let imageBuffer = response;
  fs.writeFile(path, imageBuffer["data"], "binary", function (err) {
    if (err != null) {
      console.log(err);
    }
  });
};

const generatedLoadBalanceMessage = (message) => {
  const loadBalancedSender = SENDER_LOAD_BALANCE.split(",");
  // const seconds = dayjs(message._createdAt).unix();
  const phone = parseInt(message.phone);
  let result = message;

  if (
    loadBalancedSender.length > 1 &&
    !["6283179715536", "628973787777"].includes(result.sender)
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

const base64Encode = (file) => {
  //read image file
  const data = fs.readFileSync(file);
  //get image file extension name
  let extensionName = path.extname(`${file}`);
  //convert image file to base64-encoded string
  let base64Image = new Buffer(data, "binary").toString("base64");
  //combine all strings
  let imgSrcString = `data:image/${extensionName
    .split(".")
    .pop()};base64,${base64Image}`;
  return imgSrcString;
};

start();
