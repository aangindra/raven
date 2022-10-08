require("dotenv").config();
const {
  Client,
  LegacySessionAuth,
  NoAuth,
  MessageMedia,
} = require("whatsapp-web.js");
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const fs = require("fs");
const mime = require("mime");
const fetch = require("node-fetch");
const { URL } = require("url");
const uuidV4 = require("uuid/v4");
const { isEmpty } = require("lodash");
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";
const mongodbConnection = require("./mongodb_connection");
const { initRedis } = require("./redisCache");
const Pusher = require("pusher");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");
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

const start = async () => {
  const SESSION_FILE_PATH = `./saved_sessions/${WA_SESSION}.data.json`;
  let sessionCfg;
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
  }

  const collection = await mongodbConnection("WA");
  const { cache } = await initRedis();
  let authOptions = {
    authStrategy: new LegacySessionAuth({
      session: sessionCfg,
    }),
  };
  if (process.env.IS_MULTI_DEVICE === "true") {
    authOptions = {
      authStrategy: new NoAuth(),
    };
  }
  const client = new Client({
    puppeteer: {
      authTimeout: 0, // https://github.com/pedroslopez/whatsapp-web.js/issues/935#issuecomment-952867521
      qrTimeoutMs: 0,
      headless: true,
      args: browserArgs,
    },
    // session: sessionCfg,
    ...authOptions,
  });

  client.initialize();

  client.on("authenticated", (session) => {
    console.log("authenticated!");
    sessionData = session;
    fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), (err) => {
      if (err) {
        console.error(err);
      }
    });
  });

  client.on("message", async (msg) => {
    const isFromGroup = msg.from.endsWith("@g.us");
    const fromNumber = msg.from.replace(/\D/g, "");
    if (
      fromNumber &&
      !isFromGroup &&
      !msg.id.fromMe &&
      !msg.hasMedia &&
      msg.type === "chat"
    ) {
      var cacheKey = `whatsapp_auto_replies_${WA_SESSION}`;
      var cacheResult = await cache.getAsync(cacheKey);
      let foundAutoReply = "";

      if (cacheResult !== null) {
        foundAutoReply = JSON.parse(cacheResult);
      } else {
        foundAutoReply = await collection("WhatsappAutoReplies").findOne({
          sender: WA_SESSION,
        });
        await cache.set(cacheKey, JSON.stringify(foundAutoReply));
      }

      collection("Messages").insertOne({
        _id: uuidV4(),
        sender: WA_SESSION,
        phone: fromNumber,
        // notificationType: msg.notificationType,
        checkSendByGroupContacts: false,
        groupIds: [],
        fromMessage: msg.body,
        message: foundAutoReply.message,
        type: "AUTOREPLY",
        file: "",
        image: "",
        isScheduled: false,
        response: JSON.stringify(msg),
        _createdAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });
    } else {
      collection("MessagesLogs").insertOne({
        _id: uuidV4(),
        sender: WA_SESSION,
        phone: fromNumber,
        checkSendByGroupContacts: false,
        groupIds: [],
        fromMessage: msg.body,
        message: "logs",
        type: "AUTOREPLY",
        file: "",
        image: "",
        isScheduled: false,
        response: JSON.stringify(msg),
        _createdAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });
    }
  });

  let result;

  result = await new Promise((resolve, reject) => {
    client.on("ready", () => {
      console.log("ready sending message...");
      resolve(true);
    });
  });

  const isConnected = result;
  schedule.scheduleJob("*/10 * * * * *", async () => {
    if (isConnected) {
      await sendMessage(client, cache, collection);
      await sendMessageSchedule(client, cache, collection);
    } else {
      console.log("Whatsapp not connected!");
    }
  });

  return "success";
};

const sendMessage = async (client, cache, collection) => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  await collection("Messages").createIndex({
    sender: 1,
  });

  var cacheKeySenderLists = `WA_sender_lists`;
  var stringResultSenderLists = await cache.getAsync(cacheKeySenderLists);
  let listSenders = "";

  if (stringResultSenderLists !== null) {
    listSenders = JSON.parse(stringResultSenderLists);
  } else {
    listSenders = await collection("Devices")
      .find({
        _deletedAt: {
          $exists: false,
        },
      })
      .toArray();
    listSenders = listSenders.map((sender) => sender.phone);
    stringResultSenderLists = JSON.stringify(listSenders);
    await cache.set(cacheKeySenderLists, stringResultSenderLists);
  }

  const foundMessage = await collection("Messages").findOne({
    sender: WA_SESSION,
    $and: [
      {
        phone: {
          $ne: "",
        },
        phone: {
          $nin: listSenders,
        },
      },
    ],
    $or: [
      {
        sentAt: {
          $exists: false,
        },
        errorAt: {
          $exists: false,
        },
      },
    ],
    _deletedAt: {
      $exists: false,
    },
  });

  if (!client) {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      "Device not connected!"
    );
    await updateStatusDevice(WA_SESSION, "DISCONNECTED", collection);
    // delete file qr and token
    let pathQrCode = __dirname + `/log_qr/qrCode_${WA_SESSION}.png`;
    let pathTokens = __dirname + `/saved_tokens/${WA_SESSION}.data.json`;
    try {
      if (fs.existsSync(pathQrCode)) {
        fs.unlinkSync(pathQrCode);
      }
      if (fs.existsSync(pathTokens)) {
        fs.unlinkSync(pathTokens);
      }
    } catch (e) {
      console.log(e);
    }
    return false;
  }
  if (!foundMessage) {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      "not found message..."
    );
    return false;
  } else {
    var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
    var stringResult = await cache.getAsync(cacheKey);
    let foundCache = "";
    if (stringResult !== null) {
      foundCache = JSON.parse(stringResult);
    }
    if (foundCache) {
      if (foundCache._id === foundMessage._id) {
        console.log("Cache Hit!", dayjs().format("YYYY-MM-DD HH:mm:ss"));
        await collection("Messages").updateOne(
          {
            _id: foundMessage._id,
          },
          {
            $set: {
              sentAt: dayjs().toISOString(),
              isPending: true,
              _updatedAt: dayjs().toISOString(),
            },
          }
        );
        cache.del(cacheKey);
        return false;
      } else {
        console.log(
          dayjs().format("YYYY-MM-DD HH:mm:ss"),
          " ",
          `found message for ${foundMessage.phone}!`
        );
      }
    }
  }
  try {
    const validPhone = await client.getNumberId(`${foundMessage.phone}@c.us`);

    if (isEmpty(validPhone)) {
      await collection("Messages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            errorMessage: "Invalid phone number!",
            errorAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
      );
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `${foundMessage.phone} not have whatsapp!`
      );
      return false;
    }

    let result;
    if (foundMessage.type === "IMAGE" && foundMessage.image) {
      const media = await MessageMedia.fromUrl(foundMessage.image);
      client.sendMessage(`${foundMessage.phone}@c.us`, media);
      client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
      result = true;
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      const document = await getDocumentFromUrl(foundMessage.file);
      const media = new MessageMedia(
        document.mimetype,
        document.data,
        document.filename
      );
      // const media = await MessageMedia.fromUrl(foundMessage.file);

      if (media) {
        client.sendMessage(`${foundMessage.phone}@c.us`, media, {
          caption: "document",
        });
        client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
        result = true;
        var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
        var stringResult = JSON.stringify(foundMessage);
        await cache.set(cacheKey, stringResult);
      } else {
        await collection("Messages").updateOne(
          {
            _id: foundMessage._id,
          },
          {
            $set: {
              errorMessage: "File tidak terkirim",
              errorAt: dayjs().toISOString(),
              _updatedAt: dayjs().toISOString(),
            },
          }
        );
      }
    } else {
      client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
      result = true;
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    }

    if (!result) {
      console.warn(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        "Whatsapp not connected!"
      );
    } else {
      await collection("Messages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            sentAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
      );
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `message for ${foundMessage.phone} is sent!`
      );
    }
  } catch (e) {
    await collection("Messages").updateOne(
      {
        _id: foundMessage._id,
      },
      {
        $set: {
          errorMessage: JSON.stringify(e),
          errorAt: dayjs().toISOString(),
          _updatedAt: dayjs().toISOString(),
        },
      }
    );
    console.log(e);
  }
  return true;
};

const sendMessageSchedule = async (client, cache, collection) => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });

  var cacheKeySenderLists = `WA_sender_lists`;
  var stringResultSenderLists = await cache.getAsync(cacheKeySenderLists);
  let listSenders = "";

  if (stringResultSenderLists !== null) {
    listSenders = JSON.parse(stringResultSenderLists);
  } else {
    listSenders = await collection("Devices")
      .find({
        _deletedAt: {
          $exists: false,
        },
      })
      .toArray();
    listSenders = listSenders.map((sender) => sender.phone);
    stringResultSenderLists = JSON.stringify(listSenders);
    await cache.set(cacheKeySenderLists, stringResultSenderLists);
  }

  let foundMessage = await collection("ScheduleMessages")
    .find({
      sender: WA_SESSION,
      $and: [
        {
          phone: {
            $ne: "",
          },
          phone: {
            $nin: listSenders,
          },
        },
      ],
      $or: [
        {
          sentAt: {
            $exists: false,
          },
          errorAt: {
            $exists: false,
          },
        },
      ],
      _deletedAt: {
        $exists: false,
      },
      scheduleDate: {
        $gte: dayjs().startOf("day").toISOString(),
        $lte: dayjs().endOf("day").toISOString(),
      },
    })
    .sort({
      scheduleHour: 1,
    })
    .limit(1)
    .toArray();

  if (!client) {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      "Device not connected!"
    );
    await updateStatusDevice(WA_SESSION, "DISCONNECTED", collection);
    // delete file qr and token
    let pathQrCode = __dirname + `/log_qr/qrCode_${WA_SESSION}.png`;
    let pathTokens = __dirname + `/saved_tokens/${WA_SESSION}.data.json`;
    try {
      if (fs.existsSync(pathQrCode)) {
        fs.unlinkSync(pathQrCode);
      }
      if (fs.existsSync(pathTokens)) {
        fs.unlinkSync(pathTokens);
      }
    } catch (e) {
      console.log(e);
    }
    return false;
  }
  if (!foundMessage || foundMessage.length < 1) {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      "not found schedule message..."
    );
    return false;
  }
  foundMessage = foundMessage[0];
  let scheduleDate = dayjs(foundMessage.scheduleDate).format("YYYY-MM-DD");
  console.log(
    `Last message >>> ${foundMessage.name} date ${scheduleDate} ${foundMessage.scheduleHour}`
  );
  if (!dayjs().isAfter(dayjs(`${scheduleDate} ${foundMessage.scheduleHour}`))) {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      "message are still below schedule..."
    );
    return false;
  } else {
    console.log(
      dayjs().format("YYYY-MM-DD HH:mm:ss"),
      " ",
      `found message for ${foundMessage.phone}!`
    );
  }
  try {
    const validPhone = await client.getNumberId(`${foundMessage.phone}@c.us`);
    if (isEmpty(validPhone)) {
      await collection("ScheduleMessages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            errorMessage: validPhone,
            errorAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
      );
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `${foundMessage.phone} dont have whatsapp!`
      );
      return false;
    }
    let result;
    if (foundMessage.type === "IMAGE") {
      const media = await MessageMedia.fromUrl(foundMessage.image);
      client.sendMessage(`${foundMessage.phone}@c.us`, media);
      client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
      result = true;
    } else if (foundMessage.type === "FILE") {
      const document = await getDocumentFromUrl(foundMessage.file);
      const media = new MessageMedia(
        document.mimetype,
        document.data,
        document.filename
      );
      // const media = await MessageMedia.fromUrl(foundMessage.file);

      if (media) {
        client.sendMessage(`${foundMessage.phone}@c.us`, media);
        client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
        result = true;
        var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
        var stringResult = JSON.stringify(foundMessage);
        await cache.set(cacheKey, stringResult);
      } else {
        await collection("Messages").updateOne(
          {
            _id: foundMessage._id,
          },
          {
            $set: {
              errorMessage: "File tidak terkirim",
              errorAt: dayjs().toISOString(),
              _updatedAt: dayjs().toISOString(),
            },
          }
        );
      }
    } else if (foundMessage.type === "AUTOREPLY") {
      result = await client.sendMessage(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
    } else {
      client.sendMessage(`${foundMessage.phone}@c.us`, foundMessage.message);
      result = true;
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
    }

    if (!result) {
      console.warn(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        "Whatsapp not connected!"
      );
    } else {
      await collection("ScheduleMessages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            sentAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
      );
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `message for ${foundMessage.phone} is sent!`
      );
    }
  } catch (e) {
    await collection("ScheduleMessages").updateOne(
      {
        _id: foundMessage._id,
      },
      {
        $set: {
          errorMessage: JSON.stringify(e),
          errorAt: dayjs().toISOString(),
          _updatedAt: dayjs().toISOString(),
        },
      }
    );
    console.log(e);
  }

  return true;
};

const getDocumentFromUrl = async (url, options = {}) => {
  let mimetype;

  if (!options.unsafeMime) {
    const pUrl = new URL(url);
    mimetype = mime.getType(pUrl.pathname);

    if (!mimetype) throw new Error("Unable to determine MIME type");
  }

  const reqOptions = Object.assign(
    { headers: { accept: "image/* video/* text/* audio/*" } },
    options
  );
  const response = await fetch(url, reqOptions);
  const resultMime = response.headers.get("Content-Type");
  let data = "";

  if (response.buffer) {
    data = (await response.buffer()).toString("base64");
  } else {
    const bArray = new Uint8Array(await response.arrayBuffer());
    bArray.forEach((b) => {
      data += String.fromCharCode(b);
    });
    data = btoa(data);
  }

  if (!mimetype) mimetype = resultMime;
  return {
    mimetype,
    data,
    filename: uuidV4(),
  };
};

const updateStatusDevice = async (phone, status, collection) => {
  await collection("Devices").updateOne(
    {
      phone,
    },
    {
      $set: {
        status,
      },
    }
  );
};

start();
