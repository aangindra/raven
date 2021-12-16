require("dotenv").config();
const venom = require("venom-bot");
const { writeFileSync, existsSync, mkdirSync } = require("fs");
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const axios = require("axios");
const fs = require("fs");
const fetchBase64 = require("fetch-base64");
const uuidV4 = require("uuid/v4");
const qs = require("qs");
const WA_SESSION = process.env.WA_SESSION ? process.env.WA_SESSION : "default0";
const mongodbConnection = require("./mongodb_connection");
const { initRedis } = require("./redisCache");
const Pusher = require("pusher");
const { API_URL_FONNTE, API_KEY_FONNTE, ID_PENGIRIM, PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");

const start = async () => {
  const config = {
    headers: {
      Authorization: API_KEY_FONNTE,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  let currentSession = {};
  if (fs.existsSync(__dirname + `/saved_tokens/${WA_SESSION}.data.json`)) {
    //file exists
    currentSession = JSON.parse(fs.readFileSync(__dirname + `/saved_tokens/${WA_SESSION}.data.json`, 'utf8'));
  }

  const collection = await mongodbConnection("WA");
  const { cache } = await initRedis();
  schedule.scheduleJob("*/10 * * * * *", async () => {

    await sendMessage(cache, collection, config);
    await sendMessageSchedule(cache, collection, config);

  });
  return "success";
};

const sendMessage = async (cache, collection, config) => {
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
      // let extension = foundMessage.image.split(".");
      // extension = extension[extension.length - 1];
      await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        // text: foundMessage.message,
        type: "image",
        url: foundMessage.image,
        delay: "10",
      }), config);

      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      // let extension = foundMessage.file.split(".");
      // extension = extension[extension.length - 1];
      await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
      }), config);
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        // text: foundMessage.message,
        type: "file",
        url: foundMessage.file,
        delay: "10",
      }), config);

    } else {
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
      result = true;
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    }

    console.log(response.data)

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
    } else {
      await collection("Messages").updateOne(
        {
          _id: foundMessage._id,
        },
        {
          $set: {
            sentAt: dayjs().toISOString(),
            sentMessage: JSON.stringify(response.data),
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
    if (e) {
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
    } else {
      console.log("Error >", e.response);
    }
  }
  return true;
};

const sendMessageSchedule = async (cache, collection, config) => {
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
      `found schedule message for ${foundMessage.phone}!`
    );
  }
  try {

    let result;
    let response = false;
    if (foundMessage.type === "IMAGE" && foundMessage.image) {
      // let extension = foundMessage.image.split(".");
      // extension = extension[extension.length - 1];
      await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        // text: foundMessage.message,
        type: "image",
        url: foundMessage.image,
        delay: "10",
      }), config);

      var cacheKey = `WA_sender=${foundMessage.sender}_phone=${foundMessage.phone}_type=${foundMessage.type}`;
      var stringResult = JSON.stringify(foundMessage);
      await cache.set(cacheKey, stringResult);
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      // let extension = foundMessage.file.split(".");
      // extension = extension[extension.length - 1];
      await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        // text: foundMessage.message,
        type: "file",
        url: foundMessage.file,
        delay: "10",
      }), config);

    } else if (foundMessage.type === "AUTOREPLY") {
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
    } else {
      response = await axios.post(`https://${API_URL_FONNTE}/api/send_message.php`, qs.stringify({
        phone: foundMessage.phone,
        type: "text",
        text: foundMessage.message,
        delay: "10",
      }), config);
      let calculate = await calculateMessage(collection);
      pusher.trigger("whatsapp-gateway", "message", calculate);
    }

    if (!response) {
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
            sentMessage: JSON.stringify(response.data),
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
    if (e) {
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
    } else {
      console.log("Error >", e.response);
    }
    console.log("Error >", e);

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
