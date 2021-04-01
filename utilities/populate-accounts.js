const uuidV4 = require("uuid/v4");
const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const mongodbConnection = require("../mongodb_connection");
const jwt = require("jsonwebtoken");
const SECRET_KEY = process.env.SECRET_KEY ? process.env.SECRET_KEY : uuidV4();
const GENERATED_TOKEN = process.env.GENERATED_TOKEN
  ? process.env.GENERATED_TOKEN
  : uuidV4();

const start = async () => {
  const collection = await mongodbConnection();

  let allAccounts = await collection("Accounts")
    .find({
      _deletedAt: {
        $exists: false,
      },
    })
    .toArray();

  const username = "whatsapp-gateway";
  const password = "whatsapp-gateway7656";

  const hashedPassword = bcrypt.hashSync(password, 8);

  if (!allAccounts || allAccounts.length < 1) {
    const { _id } = jwt.verify(GENERATED_TOKEN, SECRET_KEY);
    await collection("Accounts").insertOne({
      _id,
      username,
      password: hashedPassword,
      _createdAt: new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });
    await collection("UserTokens").insertOne({
      _id: uuidV4(),
      accountId: _id,
      _token: GENERATED_TOKEN,
      _createdAt: new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });
  }

  allAccounts = await collection("Accounts")
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

//# OTP
// 6283179715536

//# WA Gateway
// 6285157574640