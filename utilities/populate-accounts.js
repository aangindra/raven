const uuidV4 = require("uuid/v4");
const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const mongodbConnection = require("../mongodb_connection");
const jwt = require("jsonwebtoken");
const SECRET_KEY = process.env.SECRET_KEY ? process.env.SECRET_KEY : uuidV4();

const start = async () => {
  const collection = await mongodbConnection();

  const allAccounts = await collection("Accounts")
    .find({
      _deletedAt: {
        $exists: false,
      },
    })
    .toArray();

  const allDevices = await collection("Devices")
    .find({
      _deletedAt: {
        $exists: false,
      },
    })
    .toArray();

  for (const device of allDevices) {
    await collection("Devices").updateOne(
      {
        _id: device._id,
      },
      {
        $set: {
          accountId: allAccounts.map((account) => account._id),
        },
      }
    );
  }
  process.exit();
};

start();
