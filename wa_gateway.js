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
const { API_KEY, ID_PENGIRIM, PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");

const start = async () => {
  let currentSession = {};
  if (fs.existsSync(__dirname + `/saved_tokens/${WA_SESSION}.data.json`)) {
    //file exists
    currentSession = JSON.parse(fs.readFileSync(__dirname + `/saved_tokens/${WA_SESSION}.data.json`, 'utf8'));
  }

  const collection = await mongodbConnection("WA");
  const { cache } = await initRedis();
  schedule.scheduleJob("*/10 * * * * *", async () => {

    await sendMessage(cache, collection);
    await sendMessageSchedule(cache, collection);

  });
  return "success";
};

const sendMessage = async (cache, collection) => {
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
    let result;
    let response = false;
    if (foundMessage.type === "IMAGE" && foundMessage.image) {
      let extension = foundMessage.image.split(".");
      extension = extension[extension.length - 1];

      response = await axios.post("https://my.kirimwa-aja.com/api/media-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
        filetype: extension,
        url: foundMessage.image
      });

      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      let extension = foundMessage.file.split(".");
      extension = extension[extension.length - 1];

      response = await axios.post("https://my.kirimwa-aja.com/api/media-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
        filetype: extension,
        url: foundMessage.file
      });

    } else {
      response = await axios.post("https://my.kirimwa-aja.com/api/message-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
      }); 
      result = true;
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    }

    if (!response || response.data.status === false) {
      await collection("Messages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            errorMessage: JSON.stringify(response.data),
            errorAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
      );
      console.log(response.data)
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
          errorMessage: JSON.stringify(e.response),
          errorAt: dayjs().toISOString(),
          _updatedAt: dayjs().toISOString(),
        },
      }
    );
    console.log(e.response);
  }
  return true;
};
const sendMessageSchedule = async (cache, collection) => {
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
   
    let result;
    let response = false;
    if (foundMessage.type === "IMAGE" && foundMessage.image) {
      let extension = foundMessage.image.split(".");
      extension = extension[extension.length - 1];

      response = await axios.post("https://my.kirimwa-aja.com/api/media-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
        filetype: extension,
        url: foundMessage.image
      });

      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      let extension = foundMessage.file.split(".");
      extension = extension[extension.length - 1];

      response = await axios.post("https://my.kirimwa-aja.com/api/media-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
        filetype: extension,
        url: foundMessage.file
      });

    } else if (foundMessage.type === "AUTOREPLY") {
      response = await axios.post("https://my.kirimwa-aja.com/api/message-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
      }); 
    } else {
      response = await axios.post("https://my.kirimwa-aja.com/api/message-api.php", {
        api_key: API_KEY,
        sender: ID_PENGIRIM,
        number: foundMessage.phone,
        message: foundMessage.message,
      }); 
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
    }

    if (!response || response.data.status === false) {
      await collection("ScheduleMessages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            errorMessage: JSON.stringify(response.data),
            errorAt: dayjs().toISOString(),
            _updatedAt: dayjs().toISOString(),
          },
        }
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
          errorMessage: JSON.stringify(e.response),
          errorAt: dayjs().toISOString(),
          _updatedAt: dayjs().toISOString(),
        },
      }
    );
    console.log(e.response);
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
