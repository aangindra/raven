require("dotenv").config();
const venom = require("venom-bot");
const { writeFileSync, existsSync, mkdirSync } = require("fs");
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const axios = require("axios");
const fs = require("fs");
const fetchBase64 = require("fetch-base64");
const uuidV4 = require("uuid/v4");
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";
const mongodbConnection = require("./mongodb_connection");
const { initRedis } = require("./redisCache");
const Pusher = require("pusher");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");
const currentSession = require(`./tokens/${WA_SESSION}.data.json`);

const start = async () => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  const collection = await mongodbConnection("WA");
  const { cache } = await initRedis();
  const client = await venom.create(
    WA_SESSION,
    (base64Qr, asciiQR) => {
      if (!existsSync(`./log_qr`)) {
        mkdirSync(`./log_qr`, { recursive: true });
      }
      exportQR(base64Qr, `log_qr/qrCode_${WA_SESSION}.png`);
    },
    (statusSession) => {
      console.log(statusSession);
    },
    {
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
    },
    {
      ...currentSession
    }
  );
  client.onStateChange((state) => {
    const conflits = [
      venom.SocketState.CONFLICT,
      venom.SocketState.UNPAIRED,
      venom.SocketState.UNLAUNCHED,
    ];
    if (conflits.includes(state)) {
      client.useHere();
      if (state === "UNPAIRED") {
        console.log("WA DISCONNECTED!");
      }
    }
  });
  client.onMessage(async (message) => {
    const foundAutoReply = await collection("WhatsappAutoReplies").findOne({
      sender: WA_SESSION,
    });
    if (!foundAutoReply) {
      return;
    }
    if (message.isGroupMsg === false) {
      let results = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", results);
      let receivedPhone = message.from;
      receivedPhone = receivedPhone.replace(/\D/g, "");
      if (receivedPhone) {
        try {
          await collection("Messages").insertOne({
            _id: uuidV4(),
            sender: WA_SESSION,
            phone: receivedPhone,
            checkSendByGroupContacts: false,
            groupIds: [],
            message: foundAutoReply.message,
            type: "AUTOREPLY",
            file: "",
            image: "",
            isScheduled: false,
            _createdAt: new Date().toISOString(),
            _updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.log(e);
        }
      }
    }
  });
  const isConnected = await client.isConnected();
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
    let pathTokens = __dirname + `/tokens/${WA_SESSION}.data.json`;
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
    const validPhone = await client.getNumberProfile(
      `${foundMessage.phone}@c.us`
    );
    if (validPhone === 404) {
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
      const splitFilename = foundMessage.image.split("/");
      const filename = splitFilename[splitFilename.length - 1];
      result = new Promise((resolve, reject) => {
        client
          .sendImage(
            `${foundMessage.phone}@c.us`,
            `${foundMessage.image}`,
            `${filename}`,
            `${foundMessage.message}`
          )
          .then((result) => {
            resolve("success");
          })
          .catch((error) => {
            console.log("error", error);
            resolve(false);
          });
      });
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      const files = await getDocumentFromUrl(foundMessage.file);
      const splitFilename = foundMessage.file.split("/");
      const filename = splitFilename[splitFilename.length - 1];
      result = client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
      if (files) {
        new Promise((resolve, reject) => {
          client
            .sendFileFromBase64(
              `${foundMessage.phone}@c.us`,
              `${files}`,
              `${filename}`,
              `${filename}`
            )
            .then((result) => {
              resolve("success");
            })
            .catch((error) => {
              console.log("error", error);
              resolve(false);
            });
        });
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
      client.sendText(`${foundMessage.phone}@c.us`, foundMessage.message);
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
    let pathTokens = __dirname + `/tokens/${WA_SESSION}.data.json`;
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
    const validPhone = await client.getNumberProfile(
      `${foundMessage.phone}@c.us`
    );
    if (validPhone === 404) {
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
      const splitFilename = foundMessage.image.split("/");
      const filename = splitFilename[splitFilename.length - 1];
      result = new Promise((resolve, reject) => {
        client
          .sendImage(
            `${foundMessage.phone}@c.us`,
            `${foundMessage.image}`,
            `${filename}`,
            `${foundMessage.message}`
          )
          .then((result) => {
            resolve("success");
          })
          .catch((error) => {
            console.log("error", error);
            resolve(false);
          });
      });
    } else if (foundMessage.type === "FILE") {
      const files = await getDocumentFromUrl(foundMessage.file);
      const splitFilename = foundMessage.file.split("/");
      const filename = splitFilename[splitFilename.length - 1];
      result = client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
      if (files) {
        new Promise((resolve, reject) => {
          client
            .sendFile(
              `${foundMessage.phone}@c.us`,
              `${foundMessage.file}`,
              `${filename}`,
              `${filename}`
            )
            .then((result) => {
              resolve("success");
            })
            .catch((error) => {
              console.log("error", error);
              resolve(false);
            });
        });
      } else {
        await collection("ScheduleMessages").updateOne(
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
      result = await client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
    } else {
      result = client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
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
const getDocumentFromUrl = async (url) => {
  let res;
  try {
    // res = await axios.get(url, {
    // 	responseType: 'arraybuffer'
    // });
    // return `data:${res.headers['content-type']};base64,${Buffer.from(
    // 	String.fromCharCode(...new Uint8Array(res.data)),
    // 	'binary'
    // ).toString('base64')}`;
    res = await fetchBase64.remote(url);
    if (res && res.length > 1) {
      return res[1];
    } else {
      return false;
    }
  } catch (err) {
    console.log(err);
    return false;
  }
};
// Writes QR in specified path
const exportQR = (qrCode, path) => {
  qrCode = qrCode.replace("data:image/png;base64,", "");
  const imageBuffer = Buffer.from(qrCode, "base64");
  writeFileSync(path, imageBuffer);
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
