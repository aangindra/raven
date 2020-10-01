require("dotenv").config();
const fs = require("fs");
const shelljs = require("shelljs");
const yesno = require("yesno");

const { MongoClient } = require("mongodb");
let userAndPass = "";
if (
  process.env.MONGOD_USERNAME &&
  process.env.MONGOD_PASSWORD &&
  process.env.MONGOD_AUTH_SOURCE
) {
  userAndPass = `${process.env.MONGOD_USERNAME}:${process.env.MONGOD_PASSWORD}@`;
}
if (
  !process.env.MONGOD_HOST ||
  !process.env.MONGOD_PORT ||
  !process.env.MONGOD_DB
) {
  console.log("Incomplete environment variables. Process exitting...");
  process.exit(1);
}
const MONGO_URL = `mongodb://${userAndPass}${process.env.MONGOD_HOST}:${
  process.env.MONGOD_PORT
}/${process.env.MONGOD_DB}${
  process.env.MONGOD_AUTH_SOURCE
    ? "?authSource=" + process.env.MONGOD_AUTH_SOURCE
    : ""
}`;

const start = async () => {
  try {
    const PREFIX = "WHATSAPP_GATEWAY";
    console.log({ MONGO_URL, PREFIX });

    const ok = await yesno({
      question: "Are you sure you want to continue? (y/n)"
    });
    if (!ok) {
      process.exit();
    }

    const client = await MongoClient.connect(MONGO_URL, {
      useNewUrlParser: true,
      socketTimeoutMS: 30000,
      keepAlive: true,
      reconnectTries: 30000
    });
    const db = await client.db(process.env.MONGOD_DB);

    const exportPath = process.cwd() + "/db-" + PREFIX;
    shelljs.exec(`unzstd ${process.cwd()}/db-${PREFIX}.tar.zst`);
    shelljs.exec(`tar -xvf ${process.cwd()}/db-${PREFIX}.tar`);
    shelljs.exec(`rm ${process.cwd()}/db-${PREFIX}.tar`);
    if (!fs.existsSync(exportPath)) {
      fs.mkdirSync(exportPath, {
        recursive: true
      });
    }
    const fileNames = fs
      .readdirSync(exportPath)
      .filter(name => name.endsWith(".json"));
    console.log("Got", fileNames.length, "collections");
    for (const fileName of fileNames) {
      const rawData = fs.readFileSync(exportPath + "/" + fileName);
      const data = JSON.parse(rawData);
      const collectionName = fileName.replace(".json", "");
      console.log(collectionName + ".json", "Got", data.length, "data");

      const bulk = await db
        .collection(collectionName)
        .initializeUnorderedBulkOp();
      for (const document of data) {
        const { _id, ...body } = document;
        bulk
          .find({ _id })
          .upsert()
          .updateOne({
            $setOnInsert: {
              _id
            },
            $set: {
              ...body
            }
          });
      }
      await bulk.execute();
    }

    shelljs.exec(`rm -rf ${exportPath}`);
  } catch (e) {
    console.log(e);
  }
  process.exit();
};

start();
