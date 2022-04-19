require("dotenv").config();
const { Client, LegacySessionAuth, NoAuth, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const fs = require("fs");
const mime = require('mime');
const fetch = require('node-fetch');
const { URL } = require('url');
const uuidV4 = require("uuid/v4");
const { isEmpty } = require("lodash");
const path = require("path");
const axios = require("axios");
const utils = require("./libs/utils");
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";
const mongodbConnection = require("./mongodb_connection");
const { initRedis } = require("./redisCache");
const Pusher = require("pusher");
const { RAVEN_API_HOST, RAVEN_TOKEN, PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");
const {
  createSession,
  formatPhone,
  getSession,
  deleteSession,
  isExists,
} = require('./baileys');
const browserArgs = [
  '--disable-web-security', '--no-sandbox', '--disable-web-security', '--disable-gpu',
  '--aggressive-cache-discard', '--disable-cache', '--disable-application-cache',
  '--disable-offline-load-stale-cache', '--disk-cache-size=0', '--disable-software-rasterizer',
  '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
  '--disable-sync', '--disable-translate', '--hide-scrollbars', '--metrics-recording-only',
  '--mute-audio', '--no-first-run', '--safebrowsing-disable-auto-update', '--disable-dev-shm-usage',
  '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list'
];

const start = async () => {
  const SESSION_FILE_PATH = `./saved_sessions/${WA_SESSION}.data.json`;
  let sessionCfg;
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
  }

  const collection = await mongodbConnection("WA");
  const { cache } = await initRedis();

  schedule.scheduleJob("*/10 * * * * *", async () => {
    await sendMessage({ collection, cache });
    await sendMessageSchedule({ collection, cache });
  });

  return "success";
};

const sendMessage = async ({ collection, cache }) => {
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
      {
        sentAt: {
          $exists: false,
        },
      },
      {
        errorAt: {
          $exists: false,
        },
      }
    ],
    _deletedAt: {
      $exists: false,
    },
  });

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
    } else {
      console.log(
        dayjs().format("YYYY-MM-DD HH:mm:ss"),
        " ",
        `found message for ${foundMessage.phone} ${foundMessage.message}!`
      );
    }
  }
  try {
    axios.post(
      `${RAVEN_API_HOST}/send_message_baileys`,
      {
        session: WA_SESSION,
        phone: foundMessage.phone,
        messageType: "INSTANT",
        payload: foundMessage
      },
      {
        headers: {
          Authorization: RAVEN_TOKEN
        }
      }
    );

    // if (response.data.status === true) {
    await collection("Messages").updateOne({
      _id: foundMessage._id
    }, {
      $set: {
        sentAt: new Date().toISOString(),
      }
    })
    stringResult = JSON.stringify(foundMessage);
    await cache.set(cacheKey, stringResult);

    // }
    // pusher.trigger("whatsapp-gateway", "message", calculate);

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
    // console.log(e);
  }
  return true;
};

const sendMessageSchedule = async ({ collection, cache }) => {
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
      `found schedule message for ${foundMessage.phone} ${foundMessage.message}!`
    );
  }
  try {
    axios.post(
      `${RAVEN_API_HOST}/send_message_baileys`,
      {
        session: WA_SESSION,
        phone: foundMessage.phone,
        messageType: "SCHEDULED",
        payload: foundMessage
      },
      {
        headers: {
          Authorization: RAVEN_TOKEN
        }
      }
    );

    // if (response.data.status === true) {
    await collection("ScheduleMessages").updateOne({
      _id: foundMessage._id
    }, {
      $set: {
        sentAt: new Date().toISOString(),
      }
    })
    stringResult = JSON.stringify(foundMessage);
    await cache.set(cacheKey, stringResult);
    // }

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
  }

  return true;
};

start();