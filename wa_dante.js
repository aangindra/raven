require("dotenv").config();
const { Client, Location, List, Buttons } = require('whatsapp-web.js');
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
const browserArgs = [
  '--disable-web-security', '--no-sandbox', '--disable-web-security',
  '--aggressive-cache-discard', '--disable-cache', '--disable-application-cache',
  '--disable-offline-load-stale-cache', '--disk-cache-size=0',
  '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
  '--disable-sync', '--disable-translate', '--hide-scrollbars', '--metrics-recording-only',
  '--mute-audio', '--no-first-run', '--safebrowsing-disable-auto-update',
  '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list'
];

const start = async () => {
  const SESSION_FILE_PATH = `./saved_sessions/${WA_SESSION}.data.json`;
  let sessionCfg;
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
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

  const client = new Client({
    session: sessionCfg
  });

  client.initialize();

  client.on('authenticated', (session) => {
    console.log('authenticated!')
    sessionData = session;
    fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), (err) => {
      if (err) {
        console.error(err);
      }
    });
  });



  client.on("message", (msg) => {
    if (msg.body === "ping") {
      client.sendMessage('628973787777@c.us', 'test yu');
    }
  });

  let result

  client.on("ready", () => {
    console.log("ready sending message...");
    result = true
  });

  // console.log("status", client.getState());
  // const isConnected = result;
  // schedule.scheduleJob("*/10 * * * * *", async () => {
  //   if (isConnected) {
  //     await sendMessage({ client: result, cache, collection });
  //     await sendMessageSchedule({ client: result, cache, collection });
  //   } else {
  //     console.log("Whatsapp not connected!");
  //   }
  // });

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