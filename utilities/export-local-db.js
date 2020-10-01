require("dotenv").config();
const fs = require("fs");
const shelljs = require("shelljs");

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

    const client = await MongoClient.connect(MONGO_URL, {
      useNewUrlParser: true
    });
    const db = await client.db(process.env.MONGOD_DB);
    const collections = await db.listCollections().toArray();
    // console.log({ collections });
    const exportPath = process.cwd() + "/db-" + PREFIX;
    if (fs.existsSync(exportPath)) {
      shelljs.exec(`rm -rf ${exportPath}`);
    }
    fs.mkdirSync(exportPath, {
      recursive: true
    });

    for (const collection of collections) {
      let query = {};
      const data = await db
        .collection(collection.name)
        .find(query)
        .toArray();
      if (data.length > 0) {
        console.log(collection.name + ".json", "Got", data.length, "data");
        fs.writeFileSync(
          exportPath + "/" + collection.name + ".json",
          JSON.stringify(data)
        );
      }
    }

    shelljs.exec(`rm ${process.cwd()}/db-${PREFIX}.tar.zst`);
    shelljs.exec(
      `tar --use-compress-program zstd -cf db-${PREFIX}.tar.zst db-${PREFIX}`
    );
    shelljs.exec(`rm -rf ${exportPath}`);

    shelljs.exec(
      `cp db-${PREFIX}.tar.zst ${process.env["HOME"] + "/backupDB"}`
    );
  } catch (e) {
    console.log(e);
  }
  process.exit();
};

start();
