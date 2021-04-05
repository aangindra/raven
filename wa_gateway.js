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
const Pusher = require("pusher");
const { PUSHER_APP_ID, PUSHER_APP_KEY, PUSHER_APP_SECRET } = process.env;
const { calculateMessage } = require("./calculate_message");

const start = async () => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  const collection = await mongodbConnection("WA");
  console.log(WA_SESSION);
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
      headless: true, // Headless chrome
      devtools: false, // Open devtools by default
      useChrome: true, // If false will use Chromium instance
      debug: false, // Opens a debug session
      logQR: true, // Logs QR automatically in terminal
      browserArgs: ["--no-sandbox"], // Parameters to be added into the chrome browser instance
      refreshQR: 15000, // Will refresh QR every 15 seconds, 0 will load QR once. Default is 30 seconds
      autoClose: false, // Will auto close automatically if not synced, 'false' won't auto close. Default is 60 seconds (#Important!!! Will automatically set 'refreshQR' to 1000#)
      disableSpins: true, // Will disable Spinnies animation, useful for containers (docker) for a better log
      disableWelcome: true,
      autoClose: 30000,
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
      // let results = await calculateMessage(collection);
      // pusher.trigger("whatsapp-gateway", "message", results);
      let receivedPhone = message.from;
      try {
        await collection("Messages").insertOne({
          _id: uuidV4(),
          sender: WA_SESSION,
          phone: receivedPhone.replace(/\D/g, ""),
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
  });
  const isConnected = await client.isConnected();
  schedule.scheduleJob("*/20 * * * * *", async () => {
    if (isConnected) {
      await sendMessage(client, collection);
      await sendMessageSchedule(client, collection);
    } else {
      console.log("Whatsapp not connected!");
    }
  });
  return "success";
};

const sendMessage = async (client, collection) => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  const foundMessage = await collection("Messages").findOne({
    sender: WA_SESSION,
    phone: {
      $ne: "",
    },
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
      result = await new Promise((resolve, reject) => {
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
    } else if (foundMessage.type === "FILE" && foundMessage.file) {
      const files = await getDocumentFromUrl(foundMessage.file);
      const splitFilename = foundMessage.file.split("/");
      const filename = splitFilename[splitFilename.length - 1];
      result = await client.sendText(
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
      result = await client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
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
  // let results = await calculateMessage(collection);
  // pusher.trigger("whatsapp-gateway", "message", results);
  return true;
};
const sendMessageSchedule = async (client, collection) => {
  const pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_APP_KEY,
    secret: PUSHER_APP_SECRET,
    cluster: "ap1",
    useTLS: true,
  });
  const foundMessage = await collection("ScheduleMessages").findOne({
    sender: WA_SESSION,
    phone: {
      $ne: "",
    },
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
      "not found schedule message..."
    );
    return false;
  }
  let scheduleDate = dayjs(foundMessage.scheduleDate).format("YYYY-MM-DD");
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
      result = await new Promise((resolve, reject) => {
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
      result = await client.sendText(
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
      result = await client.sendText(
        `${foundMessage.phone}@c.us`,
        foundMessage.message
      );
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
  // let results = await calculateMessage(collection);
  // pusher.trigger("whatsapp-gateway", "message", results);
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
